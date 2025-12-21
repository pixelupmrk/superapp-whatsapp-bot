const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    makeInMemoryStore, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const pino = require('pino');

// --- Configuração do Firebase (Lendo do Arquivo para não dar erro de PEM) ---
let db;
try {
    const serviceAccount = require('./firebase-key.json');
    initializeApp({ credential: cert(serviceAccount) });
    db = getFirestore();
    console.log("[Firebase] Conectado com sucesso!");
} catch (error) {
    console.error("[Firebase] ERRO: Verifique se o arquivo firebase-key.json existe.", error.message);
}

// --- Configuração da IA ---
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- Configuração do Servidor ---
const app = express();
app.use(cors({ origin: true })); 
app.use(express.json());

const port = process.env.PORT || 8080;
const whatsappClients = {};
const qrCodeDataStore = {}; 

async function getOrCreateWhatsappClient(userId) {
    if (whatsappClients[userId]) return whatsappClients[userId];
    
    // Pastas separadas para múltiplos logins
    const { state, saveCreds } = await useMultiFileAuthState(`baileys_auth_${userId}`);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Mostra no terminal também para segurança
        browser: ['SuperApp VM', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeDataStore[userId] = await qrcode.toDataURL(qr);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            delete whatsappClients[userId];
            if (shouldReconnect) getOrCreateWhatsappClient(userId);
        } else if (connection === 'open') {
            console.log(`[WhatsApp] Cliente ${userId} CONECTADO!`);
            delete qrCodeDataStore[userId];
        }
    });

    whatsappClients[userId] = sock;
    return sock;
}

// --- Endpoints ---

app.get('/status', async (req, res) => {
    const userId = req.query.userId || 'admin';
    await getOrCreateWhatsappClient(userId);
    
    if (qrCodeDataStore[userId]) {
        res.send(`
            <html>
                <body style="text-align:center; font-family:sans-serif;">
                    <h1>Escaneie o QR Code (${userId})</h1>
                    <img src="${qrCodeDataStore[userId]}" width="300">
                    <p>Atualize a página se o QR expirar.</p>
                </body>
            </html>
        `);
    } else {
        res.send(`<h1>Cliente ${userId} já está CONECTADO ou carregando...</h1>`);
    }
});

app.get('/', (req, res) => {
    res.send("Servidor do Bot está ONLINE na VM!");
});

// ESCUTA OBRIGATÓRIA EM 0.0.0.0 PARA GOOGLE CLOUD
app.listen(port, '0.0.0.0', () => {
    console.log(`[Servidor] ONLINE na porta ${port}`);
});
