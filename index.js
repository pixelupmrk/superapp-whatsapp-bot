const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const qrcode = require("qrcode");
const app = express();
const port = 8080;

// Armazena os QR Codes de cada usuário separadamente
let qrCodes = {};

async function connectToWhatsApp(userId = 'default') {
    // Cria uma pasta de sessão única para cada ID de usuário
    const { state, saveCreds } = await useMultiFileAuthState('sessions/' + userId);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodes[userId] = await qrcode.toDataURL(qr);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp(userId);
        } else if (connection === 'open') {
            qrCodes[userId] = "CONECTADO";
            console.log(`USUÁRIO ${userId} CONECTADO COM SUCESSO!`);
        }
    });
}

// Rota Multiusuário: use /qrcode?id=NOME
app.get("/qrcode", (req, res) => {
    const userId = req.query.id || 'default';
    
    // Se o usuário nunca tentou conectar, inicia a conexão agora
    if (!qrCodes[userId]) {
        connectToWhatsApp(userId);
        return res.send("<h1>Iniciando sessão para " + userId + "... Aguarde 5 segundos e atualize.</h1>");
    }

    const status = qrCodes[userId];

    if (status === "CONECTADO") {
        res.send(`<h1 style='text-align:center;'>✅ ${userId} já está conectado!</h1>`);
    } else {
        res.send(`
            <body style="display:flex;flex-direction:column;align-items:center;background:#075E54;color:white;font-family:sans-serif;">
                <h1>Escaneie para: ${userId}</h1>
                <img src="${status}" style="background:white;padding:20px;border-radius:10px;">
                <p>Atualize a página se o código expirar.</p>
                <script>setTimeout(() => { location.reload(); }, 25000);</script>
            </body>
        `);
    }
});

app.listen(port, () => {
    console.log(`Servidor multiusuário rodando na porta ${port}`);
});
