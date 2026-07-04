import { z } from "zod";
import { type Fastify } from "../types";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export function authRoutes(app: Fastify) {

    // ── DEV-ONLY: auto-approve a terminal auth request ──────────────────────
    // Requires X-Master-Secret header matching HANDY_MASTER_SECRET env var.
    // Used by self-host scripts to bootstrap auth without an interactive browser.
    app.post('/v1/dev/auto-approve', {
        schema: {
            body: z.object({
                publicKey: z.string() // base64url, as it appears in the #key= URL hash
            })
        }
    }, async (request, reply) => {
        // Self-host only: never expose on a public production server. Anyone with
        // HANDY_MASTER_SECRET could otherwise authorize an arbitrary publicKey.
        if (!(process.env.HAPPY_SELF_HOST === 'true' || process.env.NODE_ENV !== 'production')) {
            return reply.code(404).send();
        }
        const masterSecret = process.env.HANDY_MASTER_SECRET;
        const provided = (request.headers as any)['x-master-secret'];
        if (!masterSecret || provided !== masterSecret) {
            return reply.code(401).send({ error: 'Invalid master secret' });
        }

        const tweetnacl = (await import("tweetnacl")).default;

        // Decode CLI ephemeral public key (base64url → bytes → hex for DB lookup)
        const cliPublicKey = privacyKit.decodeBase64(request.body.publicKey, 'base64url');
        const cliPublicKeyHex = privacyKit.encodeHex(cliPublicKey);

        log({ module: 'dev-auto-approve' }, `Auto-approve for CLI publicKey hex: ${cliPublicKeyHex.substring(0, 20)}...`);

        const authRequest = await db.terminalAuthRequest.findUnique({ where: { publicKey: cliPublicKeyHex } });
        if (!authRequest) {
            return reply.code(404).send({ error: `Auth request not found. publicKeyHex: ${cliPublicKeyHex}` });
        }

        // Generate 32-byte shared secret and encrypt it for the CLI
        const sharedSecret = new Uint8Array(randomBytes(32));
        const ephemeral = tweetnacl.box.keyPair();
        const nonce = new Uint8Array(randomBytes(tweetnacl.box.nonceLength));
        const encrypted = tweetnacl.box(sharedSecret, nonce, cliPublicKey, ephemeral.secretKey);

        // Bundle format the CLI expects: ephemeralPubKey(32) + nonce(24) + encrypted
        const bundle = new Uint8Array(ephemeral.publicKey.length + nonce.length + encrypted.length);
        bundle.set(ephemeral.publicKey, 0);
        bundle.set(nonce, ephemeral.publicKey.length);
        bundle.set(encrypted, ephemeral.publicKey.length + nonce.length);
        const responseBase64 = privacyKit.encodeBase64(bundle);

        // Upsert a system dev account as the "approver"
        const devAccount = await db.account.upsert({
            where: { publicKey: 'dev-auto-approve-system' },
            update: {},
            create: { publicKey: 'dev-auto-approve-system' }
        });

        await db.terminalAuthRequest.update({
            where: { id: authRequest.id },
            data: { response: responseBase64, responseAccountId: devAccount.id }
        });

        log({ module: 'dev-auto-approve' }, `Terminal auth auto-approved successfully`);
        return reply.send({ success: true });
    });

    // ── DEV / SELF-HOST ONLY: return CLI credentials for web app injection ───
    // Reads ~/.happy/access.key and returns { token, secret } so the web app
    // can authenticate as the same account as the CLI.
    //
    // Security: this endpoint is only registered when HAPPY_SELF_HOST=true (or
    // NODE_ENV !== 'production'). It must never be exposed on a public-facing
    // production server because anyone who obtains HANDY_MASTER_SECRET could
    // use it to impersonate any CLI user.
    if (process.env.HAPPY_SELF_HOST === 'true' || process.env.NODE_ENV !== 'production') {
        app.get('/v1/dev/web-credentials', async (request, reply) => {
            const masterSecret = process.env.HANDY_MASTER_SECRET;
            const provided = (request.headers as any)['x-master-secret'];
            if (!masterSecret || provided !== masterSecret) {
                return reply.code(401).send({ error: 'Invalid master secret' });
            }
            const happyHome = process.env.HAPPY_HOME || join(homedir(), '.happy');
            const keyFile = join(happyHome, 'access.key');
            try {
                const contents = await readFile(keyFile, 'utf-8');
                const parsed = JSON.parse(contents);
                log({ module: 'dev-web-credentials' }, `Returning CLI credentials for web injection`);
                return reply.send(parsed);
            } catch {
                return reply.code(404).send({ error: 'CLI credentials not found. Run the CLI (启动MockAI对话.command) first.' });
            }
        });
    }
    // ────────────────────────────────────────────────────────────────────────
    app.post('/v1/auth', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                challenge: z.string(),
                signature: z.string()
            })
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const challenge = privacyKit.decodeBase64(request.body.challenge);
        const signature = privacyKit.decodeBase64(request.body.signature);
        const isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        // Create or update user in database
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const user = await db.account.upsert({
            where: { publicKey: publicKeyHex },
            update: { updatedAt: new Date() },
            create: { publicKey: publicKeyHex }
        });

        return reply.send({
            success: true,
            token: await auth.createToken(user.id)
        });
    });

    app.post('/v1/auth/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                supportsV2: z.boolean().nullish()
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'auth-request' }, `Terminal auth request - publicKey hex: ${publicKeyHex}`);

        const answer = await db.terminalAuthRequest.upsert({
            where: { publicKey: publicKeyHex },
            update: {},
            create: { publicKey: publicKeyHex, supportsV2: request.body.supportsV2 ?? false }
        });

        if (answer.response && answer.responseAccountId) {
            const token = await auth.createToken(answer.responseAccountId!, { session: answer.id });
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Get auth request status
    app.get('/v1/auth/request/status', {
        schema: {
            querystring: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.object({
                    status: z.enum(['not_found', 'pending', 'authorized']),
                    supportsV2: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.query.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!authRequest) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        if (authRequest.response && authRequest.responseAccountId) {
            return reply.send({ status: 'authorized', supportsV2: false });
        }

        return reply.send({ status: 'pending', supportsV2: authRequest.supportsV2 });
    });

    // Approve auth request
    app.post('/v1/auth/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        log({ module: 'auth-response' }, `Auth response endpoint hit - user: ${request.userId}, publicKey: ${request.body.publicKey.substring(0, 20)}...`);
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            log({ module: 'auth-response' }, `Invalid public key length: ${publicKey.length}`);
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'auth-response' }, `Looking for auth request with publicKey hex: ${publicKeyHex}`);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });
        if (!authRequest) {
            log({ module: 'auth-response' }, `Auth request not found for publicKey: ${publicKeyHex}`);
            // Let's also check what auth requests exist
            const allRequests = await db.terminalAuthRequest.findMany({
                take: 5,
                orderBy: { createdAt: 'desc' }
            });
            log({ module: 'auth-response' }, `Recent auth requests in DB: ${JSON.stringify(allRequests.map(r => ({ id: r.id, publicKey: r.publicKey.substring(0, 20) + '...', hasResponse: !!r.response })))}`);
            return reply.code(404).send({ error: 'Request not found' });
        }
        if (!authRequest.response) {
            await db.terminalAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.userId }
            });
        }
        return reply.send({ success: true });
    });

    // Account auth request
    app.post('/v1/auth/account/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const answer = await db.accountAuthRequest.upsert({
            where: { publicKey: privacyKit.encodeHex(publicKey) },
            update: {},
            create: { publicKey: privacyKit.encodeHex(publicKey) }
        });

        if (answer.response && answer.responseAccountId) {
            const token = await auth.createToken(answer.responseAccountId!);
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Approve account auth request
    app.post('/v1/auth/account/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const authRequest = await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(publicKey) }
        });
        if (!authRequest) {
            return reply.code(404).send({ error: 'Request not found' });
        }
        if (!authRequest.response) {
            await db.accountAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.userId }
            });
        }
        return reply.send({ success: true });
    });

}