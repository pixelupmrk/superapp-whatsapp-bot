const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const express = require("express");
const qrcode = require("qrcode");
const app = express();
const port = 10000;

let qrCodeUrl = ""; // Armazena o QR Code atual

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true // Mantém no terminal também por segurança
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // Transforma o QR Code em uma imagem que o navegador entende
            qrCodeUrl = await qrcode.toDataURL(qr);
            console.log("NOVO QR CODE GERADO. ACESSE PELO LINK.");
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            qrCodeUrl = "CONECTADO";
            console.log("WHATSAPP CONECTADO COM SUCESSO!");
        }
    });
}

// Rota para ver o QR Code no navegador
app.get("/qrcode", (req, res) => {
    if (qrCodeUrl === "CONECTADO") {
        res.send("<h1>O WhatsApp já está conectado!</h1>");
    } else if (qrCodeUrl) {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#f0f2f5;font-family:sans-serif;">
                    <h2>Escaneie o QR Code abaixo:</h2>
                    <img src="${qrCodeUrl}" style="border:10px solid white;box-shadow:0 0 10px rgba(0,0,0,0.1);">
                    <p>Atualize a página se o código expirar.</p>
                    <script>setTimeout(() => { location.reload(); }, 30000);</script>
                </body>
            </html>
        `);
    } else {
        res.send("<h1>Gerando QR Code... aguarde e atualize a página.</h1>");
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
    connectToWhatsApp();
});
