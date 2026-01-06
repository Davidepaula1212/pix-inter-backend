import fs from "fs";
import https from "https";
import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// ================= SUPABASE =================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============ CERTIFICADO BANCO INTER ============
function writeTmpFileFromBase64(envName, filename) {
  const base64 = process.env[envName];
  if (!base64) throw new Error(`Variável ${envName} não encontrada`);
  const filePath = `/tmp/${filename}`;
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

const certPath = writeTmpFileFromBase64("INTER_CERT_B64", "inter.crt");
const keyPath = writeTmpFileFromBase64("INTER_KEY_B64", "inter.key");

const httpsAgent = new https.Agent({
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath),
});

// ============ FUNÇÕES ============
function normalizarEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function getInterToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.INTER_CLIENT_ID,
    client_secret: process.env.INTER_CLIENT_SECRET,
    scope: process.env.INTER_SCOPES,
  });

  const res = await axios.post(process.env.INTER_OAUTH_URL, body, {
    httpsAgent,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return res.data.access_token;
}

// ============ ROTAS ============

// Criar PIX
app.post("/pix/criar", async (req, res) => {
  try {
    let { pedidoId, valor } = req.body;
    pedidoId = normalizarEmail(pedidoId);

    if (!pedidoId || !pedidoId.includes("@")) {
      return res.status(400).json({ error: "Email inválido" });
    }

    const { data: existente } = await supabase
      .from("pix_orders")
      .select("*")
      .eq("pedido_id", pedidoId)
      .maybeSingle();

    if (existente?.status === "paid") {
      return res.json({ status: "paid" });
    }

    const token = await getInterToken();

    const cobranca = await axios.post(
      `${process.env.INTER_PIX_BASE_URL}/cob`,
      {
        calendario: { expiracao: 3600 },
        valor: { original: Number(valor).toFixed(2) },
        chave: process.env.INTER_PIX_CHAVE,
        solicitacaoPagador: `Pedido ${pedidoId}`,
      },
      {
        httpsAgent,
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const txid = cobranca.data.txid;

    await supabase.from("pix_orders").upsert({
      pedido_id: pedidoId,
      txid,
      valor,
      status: "pending",
    });

    return res.json({
      status: "pending",
      txid,
      dadosPix: cobranca.data,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Erro ao criar PIX",
      detalhe: e?.response?.data || e.message,
    });
  }
});

// Webhook do Banco Inter
app.post("/pix/webhook", async (req, res) => {
  try {
    const txid =
      req.body?.pix?.[0]?.txid ||
      req.body?.txid;

    if (!txid) return res.sendStatus(200);

    await supabase
      .from("pix_orders")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("txid", txid);

    return res.sendStatus(200);
  } catch {
    return res.sendStatus(200);
  }
});

// Verificar status
app.get("/pix/status", async (req, res) => {
  const pedidoId = normalizarEmail(req.query.pedidoId);

  const { data } = await supabase
    .from("pix_orders")
    .select("*")
    .eq("pedido_id", pedidoId)
    .maybeSingle();

  if (!data) return res.json({ status: "not_found" });

  return res.json(data);
});

// Health check
app.get("/", (_, res) => res.send("API PIX OK"));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
