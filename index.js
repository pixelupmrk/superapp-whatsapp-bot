// index.js - VERSÃO DEFINITIVA COM CHAVES EMBUTIDAS E GEMINI 2.0 FLASH
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

// --- Configuração do Firebase Admin (DIRETO NO CÓDIGO) ---
let db;
try {
    const serviceAccount = {
      "type": "service_account",
      "project_id": "superapp-d0368",
      "private_key_id": "f70509b4fb629813abdc73f40fc11a803110ec7f",
      "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCrfWeYwj+ZBjaE\noO58sTx+A6tTi56eNoOqWvfGMJzX6C+OvTPpKDkzYazivt7uP74ndgeP5FuCniJJ\nfqEBdoiAFx1epsEhfdvmXTqHDt6IFumfRdf3rYariMGz4zn8XiTaHP/kijOc3oh5\ntzMGFKaMnpTqPo+F+VPfAgGF263156PFoa61bnCcf7iDd2XeQWSY0ToA31PG9siU\nw+/Oz3aJv4sk3sTmSuBrcaFQ1sX0m/7IpJOm7Sy+ZWSpw9MzkSl0BVSbb5zFJlRq\nCzMdsG2imoP7ksFWPbNh7WUSnYUtwP/k62QXBRbPPRr6uc0q3YOGOrVAOEfRfWKb\neK6qp+jhAgMBAAECggEAFaOeWz1E+dHki+R5aMyTMzIn/+53QRmPOwN9jnRQkOyg\ndk9+PxEvSUItpvL/fcAXW4gI45RPeRzr0Kr6NWK3+LRx+qE/b4gfzmK8jDxJF5Jk\nlQ94IAMKd5dVx0AzRJq7OwvmZ6KKFA+p2En7VezB01lTYHeCdB0GWKE6gKHmwpzs\nvoNuSl0c/LfMtVeuex/F8/KynfLR1+1Q7aJK/AsKvuffvcJbvzfem6QzZfHldCiU\nuwcrb2CrNrQr15y3LeU61/tX60nLJPWPPZnrUdTbdiGpKWMhEnCBbSzWYO/6yJay\nmXPxKpxY3x+nF099/31sCUc5+enDFIWfc+q8fKHFjQKBgQDje1GXJc4qxjZcIsJJ\n6KWlk+ZnRtjzDakCvnMm+3teQNrE6oXUl2FboD8fTXQJqr0KU6V0UeQ1xwWBj7cz\nLCXXJsQuP9TMZSvam8A0tIaCauHuO3OWrD5829+uyP90K7Zd9dHBIp72N77m+NAb\nGH2XYPO22bBW6PWxnEXnj6lkNwKBgQDA/Ry7HvZ8cxZ/Ff9RQyA81cgFV1e6R06C\nig1x+2qWDWWN04G+jbl4Iyk1mQU0G/N2PSIr5NXJHlY+JCeiznT3pO2HcEL6GgP7\nzCwxy8Z/go9M8HTcVjiXARuazh7vy3CjhLeBgSm0tuMlS0BdQGI6VzkA/HjIazJD\nNViC9XI/pwKBgQCxlP5fqSKl37BmArh7bAOMG8Zcz0DjlMFgo/5O6zkmnihqWs54\n5GgbWCCOti8ksMX8fsoF4TvvA1v4BZI1f3xW1iuGE0xy93Php37HZjovK3MOQBj/\nAZ2SaS7YSo6pSMqH1TOWuwkvGtuLgacrz9WTTBtVneD8J8ZNjbpAh7TrxwKBgFbF\nt9Re0J8WNChCIMFN+EHCMaRNKFHGXAOPxQnZ7Iu5TE8fqXefS6Q70vyZZ+CNLMOe\nKy4nPwSl0kswgG3QfIEYtAAwtryzU9U0cS6WnBKbBommmDS1w84JnnrVcM2K4IN1\nWfkttS3fCXSsSC1llIT80NGjsz8SC9ByPPDtIUiDAoGAV5sMyJSOPYPNxB0aN7Bs\n4+2pCyAE7DUyQUz51lMuCGPbvH51Ay2PW4msNTs+rK05AUGeKBHAGuGeaSffWj6i\n/za/ynCIo0w8qjWC/CoPDOpK+UAkqriyf7AZdzGA3QH4IknXsgMY4OSM7PijLDsQ\n7FNOQ1T4e31cBxip1Qg3LWM=\n-----END PRIVATE KEY-----",
      "client_email": "firebase-adminsdk-fbsvc@superapp-d0368.iam.gserviceaccount.com",
      "client_id": "110540385840583368447",
      "universe_domain": "googleapis.com"
    };
    initializeApp({ credential: cert(serviceAccount) });
    db = getFirestore();
    console.log("[Firebase] Conectado com sucesso!");
} catch (error) {
    console.error("[Firebase] ERRO CRÍTICO:", error);
}

// --- Configuração da IA (USANDO GEMINI 2.0 FLASH) ---
const apiKey = "AIzaSyDSLlNgmXKWZnrZSw5qP2sbOYhMnsUZcGE";
const genAI = new GoogleGenerativeAI(apiKey);
// Modelo atualizado para a versão 2.0 Flash
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
console.log("[IA] Modelo Gemini 2.0 Flash configurado.");

// --- Servidor e Socket ---
const app = express();
app.use(cors({ origin: true })); 
app.use(express.json());
const port = process.env.PORT || 10000;
const whatsappClients = {};

async function getOrCreateWhatsappClient(userId) {
    let sock = whatsappClients[userId];
    if (sock && sock.user && sock.ws.readyState === sock.ws.OPEN) return sock;
    
    const { state, saveCreds } = await useMultiFileAuthState(`baileys_auth_${userId}`);
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // Isso fará o QR Code aparecer no terminal SSH
        auth: state,
        browser: ['SuperApp Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) console.log("ESCANEIE O QR CODE ABAIXO:");
        if (connection === 'open') console.log("[WhatsApp] Bot conectado e pronto!");
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        try {
            const result = await model.generateContent(text);
            const response = await result.response;
            await sock.sendMessage(msg.key.remoteJid, { text: response.text() });
        } catch (e) { console.error("Erro na IA:", e); }
    });

    whatsappClients[userId] = sock;
    return sock;
}

app.get('/', (req, res) => {
    const userId = req.query.userId || 'default';
    getOrCreateWhatsappClient(userId);
    res.send("Bot Iniciado! Olhe o terminal para o QR Code.");
});

app.listen(port, () => console.log(`Servidor na porta ${port}`));
