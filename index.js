// index.js CORRIGIDO COM ESTOQUE, GEMINI 2.5 FLASH E SYNC SUPABASE
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

// === NOVA FUNÇÃO: WEBHOOK SUPABASE ===
const SUPABASE_WEBHOOK_URL = 'https://qcrnetcdkfwtgphsezoo.supabase.co/functions/v1/bot-webhook';

async function callSupabaseWebhook(action, userId, data) {
    try {
        const response = await fetch(SUPABASE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, userId, data })
        });
        const result = await response.json();
        console.log(`[Supabase Webhook] ${action}:`, result);
        return result;
    } catch (error) {
        console.error(`[Supabase Webhook] Erro ${action}:`, error.message);
        return null;
    }
}
// === FIM DA NOVA FUNÇÃO ===

// --- Configuração do Firebase Admin ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    db = getFirestore();
    console.log("[Firebase] Conectado ao Firebase Admin!");
} catch (error) {
    console.error("[Firebase] ERRO: Verifique a variável de ambiente FIREBASE_SERVICE_ACCOUNT.", error);
}

// ... resto do código igual ...

// DENTRO DA FUNÇÃO handleNewMessage, ADICIONE ESTAS CHAMADAS:

async function handleNewMessage(message, userId) {
    const userContact = message.key.remoteJid;
    const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    const contactName = message.pushName || '';

    if (!messageText || userContact === 'status@broadcast') return;

    try {
        // ... código Firebase existente ...

        // === SYNC SUPABASE: Criar/buscar lead ===
        const leadResult = await callSupabaseWebhook('new_lead', userId, {
            nome: contactName || currentLead?.nome || 'Novo Contato',
            whatsapp: userContact,
            status: 'novo',
            botActive: true
        });

        // === SYNC SUPABASE: Salvar mensagem recebida ===
        await callSupabaseWebhook('save_message', userId, {
            leadId: leadResult?.leadId,
            whatsapp: userContact,
            text: messageText,
            isFromMe: false,
            contactName: contactName
        });

        // ... resto do código da IA ...

        if (currentLead.botActive === true) {
            // ... gerar resposta IA ...
            const aiResponse = (await (await model.generateContent(fullPrompt)).response).text();

            // === SYNC SUPABASE: Salvar resposta do bot ===
            await callSupabaseWebhook('save_message', userId, {
                leadId: leadResult?.leadId,
                whatsapp: userContact,
                text: aiResponse,
                isFromMe: true
            });

            await whatsappClients[userId].sendMessage(message.key.remoteJid, { text: aiResponse });
        }

    } catch (error) {
        console.error(`[Baileys - ${userId}] Erro:`, error);
    }
}

// DENTRO DO ENDPOINT /send, ADICIONE:
app.post('/send', async (req, res) => {
    const { to, text, userId, leadId } = req.body;
    // ... validações ...

    try {
        // ... código Firebase existente ...

        // === SYNC SUPABASE: Salvar mensagem enviada ===
        await callSupabaseWebhook('save_message', userId, {
            leadId: leadId,
            whatsapp: to,
            text: text,
            isFromMe: true
        });

        // ... enviar pelo WhatsApp ...
    } catch (error) {
        // ...
    }
});
