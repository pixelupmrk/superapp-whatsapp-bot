const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const qrcode = require("qrcode");
const app = express();
const port = 8080; // Porta correta para o Google Cloud Shell

let qrCodeUrl = ""; 

async function connectToWhatsApp() {
    // Para múltiplos logins, mudaremos 'auth_info' para pastas dinâmicas depois
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
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

// Rota para o navegador
app.get("/qrcode", (req, res) => {
    if (qrCodeUrl === "CONECTADO") {
        res.send("<h1>WhatsApp já está conectado!</h1>");
    } else if (qrCodeUrl) {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#25D366;font-family:sans-serif;color:white;">
                    <div style="background:white;padding:30px;border-radius:15px;text-align:center;color:#333;">
                        <h2>Escaneie para Conectar</h2>
                        <img src="${qrCodeUrl}" style="width:300px;">
                        <p>O código atualiza sozinho.</p>
                    </div>
                    <script>setTimeout(() => { location.reload(); }, 20000);</script>
                </body>
            </html>
        `);
    } else {
        res.send("<h1>Gerando QR Code... aguarde 5 segundos e atualize a página.</h1>");
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
    connectToWhatsApp();
});
