const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const qrcode = require("qrcode");
const app = express();
const port = 8080;

let qrCodes = {};
let sessions = {};

async function connectToWhatsApp(userId) {
    if (sessions[userId]) return;
    const { state, saveCreds } = await useMultiFileAuthState('sessions/' + userId);
    const sock = makeWASocket({ auth: state, printQRInTerminal: true });
    sessions[userId] = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodes[userId] = await qrcode.toDataURL(qr);
        if (connection === 'open') {
            qrCodes[userId] = "CONECTADO";
            console.log(`[${userId}] Conectado com sucesso!`);
        }
        if (connection === 'close') {
            delete sessions[userId];
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp(userId);
        }
    });
}

app.get("/qrcode", async (req, res) => {
    const userId = req.query.id || 'default';
    if (!sessions[userId]) connectToWhatsApp(userId);
    
    setTimeout(() => {
        const status = qrCodes[userId];
        if (status === "CONECTADO") res.send(`<h1>${userId} está Conectado!</h1>`);
        else if (status) res.send(`<img src="${status}" style="width:300px;"><p>ID: ${userId}</p>`);
        else res.send("<h1>Gerando QR... atualize a página.</h1>");
    }, 2000);
});

// FORÇANDO ESCUTA EXTERNA
app.listen(port, '0.0.0.0', () => {
    console.log(`SERVIDOR MULTIUSUÁRIO ONLINE NA PORTA ${port}`);
});
