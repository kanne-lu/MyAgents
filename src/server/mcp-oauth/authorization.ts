/**
 * MCP OAuth Authorization Flow
 *
 * Handles the OAuth 2.0 Authorization Code Flow with PKCE:
 * - PKCE code challenge generation (RFC 7636, S256)
 * - Local HTTP callback server for authorization code receipt
 * - Authorization URL construction
 * - Code-to-token exchange
 * - 5-minute timeout with auto-cleanup
 *
 * Security:
 * - Callback server binds to 127.0.0.1 only
 * - State parameter for CSRF protection
 * - All HTML output XSS-escaped
 */

import { createHash, randomBytes } from 'crypto';
import http from 'http';
import type { AuthorizationConfig, OAuthTokenData, PKCEPair } from './types';

// ===== Pending Flows =====

interface PendingFlow {
  serverId: string;
  config: AuthorizationConfig;
  pkce: PKCEPair;
  callbackPort: number;
  callbackServer: http.Server;
  state: string;
  resolve: (token: OAuthTokenData | null) => void;
}

const pendingFlows = new Map<string, PendingFlow>();

/** Check if a flow is pending for a server */
export function isFlowPending(serverId: string): boolean {
  return pendingFlows.has(serverId);
}

// ===== PKCE =====

function generatePKCE(): PKCEPair {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ===== HTML Escaping =====

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCallbackHtml(success: boolean, message: string): string {
  const color = success ? '#22c55e' : '#ef4444';
  const icon = success ? '&#10003;' : '&#10007;';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MyAgents OAuth</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.card{text-align:center;padding:2rem;border-radius:12px;background:#171717;border:1px solid #262626}
.icon{font-size:3rem;color:${color}}.msg{margin-top:1rem;font-size:1.1rem}</style></head>
<body><div class="card"><div class="icon">${icon}</div><div class="msg">${message}</div>
<p style="color:#737373;font-size:0.9rem;margin-top:1rem">You can close this tab now.</p></div></body></html>`;
}

// ===== Token Exchange =====

async function exchangeCodeForToken(
  code: string,
  tokenUrl: string,
  clientId: string,
  clientSecret: string | undefined,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthTokenData> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Token exchange failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  const data = await response.json() as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error('Token exchange response missing access_token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    scope: data.scope,
  };
}

// ===== Callback Server =====

function startCallbackServer(
  serverId: string,
  port: number,
  onCode: (code: string, state: string) => void,
  onError: (error: string) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          const desc = url.searchParams.get('error_description') || error;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildCallbackHtml(false, `Authorization failed: ${escapeHtml(desc)}`));
          onError(desc);
          return;
        }

        if (code && state) {
          const flow = pendingFlows.get(serverId);
          if (flow && state !== flow.state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(buildCallbackHtml(false, 'Authorization failed: state parameter mismatch'));
            onError('State parameter mismatch');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildCallbackHtml(true, 'Authorization successful! You can close this tab.'));
          onCode(code, state);
          return;
        }

        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code or state parameter');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', (err) => {
      reject(new Error(`Callback server error: ${err.message}`));
    });

    // port=0 means OS picks random available port
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        console.log(`[mcp-oauth] Callback server for ${serverId} started on port ${addr.port}`);
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to get callback server address'));
      }
    });
  });
}

// ===== Cleanup =====

function cleanupFlow(serverId: string): void {
  const flow = pendingFlows.get(serverId);
  if (flow) {
    try { flow.callbackServer.close(); } catch { /* noop */ }
    pendingFlows.delete(serverId);
  }
}

/** Cancel a pending OAuth flow */
export function cancelFlow(serverId: string): void {
  const flow = pendingFlows.get(serverId);
  if (flow) {
    flow.resolve(null);
    cleanupFlow(serverId);
  }
}

// ===== Main Authorization Flow =====

/**
 * Start the OAuth 2.0 Authorization Code Flow with PKCE.
 *
 * @returns authUrl to open in browser + waitForToken promise
 */
export async function startAuthorizationFlow(
  serverId: string,
  config: AuthorizationConfig,
): Promise<{ authUrl: string; waitForToken: Promise<OAuthTokenData | null> }> {
  // Cancel any existing flow
  cancelFlow(serverId);

  const pkce = generatePKCE();
  const state = randomBytes(16).toString('hex');

  // Start callback server
  const callbackPort = config.callbackPort || 0;
  const { server: srv, port: srvPort } = await startCallbackServer(
    serverId,
    callbackPort,
    // onCode — handled inside the token promise
    () => {},
    // onError — handled inside the token promise
    () => {},
  );

  // Build redirect URI with actual port
  const redirectUri = `http://127.0.0.1:${srvPort}/callback`;

  // Create token promise — resolved when callback is received
  const tokenPromise = new Promise<OAuthTokenData | null>((resolveToken) => {
    // Replace the callback server's request handler with one that uses our resolve
    srv.removeAllListeners('request');
    srv.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const reqState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          const desc = url.searchParams.get('error_description') || error;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildCallbackHtml(false, `Authorization failed: ${escapeHtml(desc)}`));
          cleanupFlow(serverId);
          resolveToken(null);
          return;
        }

        if (code && reqState) {
          if (reqState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(buildCallbackHtml(false, 'Authorization failed: state parameter mismatch'));
            cleanupFlow(serverId);
            resolveToken(null);
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildCallbackHtml(true, 'Authorization successful! You can close this tab.'));

          // Exchange code for token
          exchangeCodeForToken(
            code,
            config.tokenEndpoint,
            config.clientId,
            config.clientSecret,
            pkce.codeVerifier,
            redirectUri,
          ).then((token) => {
            console.log(`[mcp-oauth] Token obtained for ${serverId}`);
            cleanupFlow(serverId);
            resolveToken(token);
          }).catch((err) => {
            console.error(`[mcp-oauth] Token exchange failed for ${serverId}:`, err);
            cleanupFlow(serverId);
            resolveToken(null);
          });
          return;
        }

        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code or state parameter');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    // Store flow state for state validation and cleanup
    pendingFlows.set(serverId, {
      serverId,
      config,
      pkce,
      callbackPort: srvPort,
      callbackServer: srv,
      state,
      resolve: resolveToken,
    });
  });

  // Build authorization URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (config.scopes?.length) {
    params.set('scope', config.scopes.join(' '));
  }

  const authUrl = `${config.authorizationEndpoint}?${params.toString()}`;
  console.log(`[mcp-oauth] Authorization flow started for ${serverId}`);

  // Auto-cleanup after 5 minutes
  setTimeout(() => {
    if (pendingFlows.has(serverId)) {
      console.warn(`[mcp-oauth] Authorization flow timed out for ${serverId}`);
      const timedOutFlow = pendingFlows.get(serverId);
      timedOutFlow?.resolve(null);
      cleanupFlow(serverId);
    }
  }, 5 * 60 * 1000);

  return { authUrl, waitForToken: tokenPromise };
}
