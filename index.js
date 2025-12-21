const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const qrcode = require("qrcode");
const app = express();
const port = 8080;

let sessions = {}; // Armazena as conexões ativas
let qrCodes = {};  // Armazena os QRs por ID

async function startWhatsApp(id) {
    if (sessions[id]) return; // Já está rodando

    const { state, saveCreds } = await useMultiFileAuthState('sessions/' + id);
    const sock = makeWASocket({ auth: state, printQRInTerminal: true });
    sessions[id] = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodes[id] = await qrcode.toDataURL(qr);
        if (connection === 'open') {
            qrCodes[id] = "CONECTADO";
            console.log(`Cliente ${id} conectado!`);
        }
        if (connection === 'close') {
            delete sessions[id];
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startWhatsApp(id);
        }
    });
}

app.get("/qrcode", (req, res) => {
    const id = req.query.id || 'default';
    if (!sessions[id]) startWhatsApp(id);

    setTimeout(() => {
        const status = qrCodes[id];
        if (status === "CONECTADO") res.send(`<h1>${id} está ON!</h1>`);
        else if (status) res.send(`<img src="${status}" width="300"><p>ID: ${id}</p>`);
        else res.send("<h1>Gerando QR... aguarde e atualize.</h1>");
    }, 3000);
});

// ESCUTA EM 0.0.0.0 PARA PERMITIR ACESSO EXTERNO
app.listen(port, '0.0.0.0', () => { 
    console.log("Servidor Multiusuário ONLINE na porta " + port); 
});
