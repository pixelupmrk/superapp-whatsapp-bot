const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const qrcode = require("qrcode");
const fs = require("fs");
const app = express();
const port = 8080; // Alterado para 8080 para funcionar no Google Cloud Shell

let qrCodeUrl = ""; 

async function connectToWhatsApp() {
    // 'auth_info' é a pasta onde o login fica salvo. 
    // Para múltiplos usuários, depois mudaremos isso para pastas dinâmicas.
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true // Mantém o QR Code no terminal também
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // Gera a imagem do QR Code para o link do navegador
            qrCodeUrl = await qrcode.toDataURL(qr);
            console.log("NOVO QR CODE GERADO. ACESSE O LINK PARA ESCANEAR.");
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
        res.send("<h1 style='text-align:center; font-family:sans-serif;'>✅ WhatsApp já está conectado!</h1>");
    } else if (qrCodeUrl) {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#075E54;font-family:sans-serif;color:white;">
                    <div style="background:white;padding:40px;border-radius:20px;text-align:center;color:#333;box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
                        <h2 style="margin-bottom:20px;">Escaneie para Conectar</h2>
                        <img src="${qrCodeUrl}" style="width:300px; border: 1px solid #ddd; padding: 10px; border-radius: 10px;">
                        <p style="margin-top:20px; color:#666;">O código atualiza automaticamente a cada 20s.</p>
                    </div>
                    <script>setTimeout(() => { location.reload(); }, 20000);</script>
                </body>
            </html>
        `);
    } else {
        res.send("<h1 style='text-align:center; font-family:sans-serif;'>⏳ Gerando QR Code... Aguarde 10 segundos e atualize a página.</h1>");
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
    connectToWhatsApp();
});
