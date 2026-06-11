/**
 * Verifica JWT OIDC assinado pelo Google.
 *
 * Usado pra validar requisições do Pub/Sub Push: quando a subscription Push
 * envia notification pro nosso endpoint, ela assina o body com um token OIDC
 * (JWT) cuja chave de assinatura está nas JWKS públicas do Google.
 *
 * Spec: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 *
 * Claims que validamos:
 *   - `iss` = `https://accounts.google.com`
 *   - `aud` = audience configurada na subscription (URL do endpoint)
 *   - `email` = service account configurada na subscription
 *   - `email_verified` = true
 *   - `exp` > agora (jose já valida exp/nbf por padrão)
 *
 * Cache: JWKS é cached pelo `jose.createRemoteJWKSet` com TTL automático
 * baseado nos headers Cache-Control do endpoint Google (~6h em geral). Não
 * precisamos gerenciar TTL nosso.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_ISSUER = 'https://accounts.google.com';

// Singleton — `createRemoteJWKSet` mantém cache interno + revalida quando
// recebe `kid` desconhecido (o que cobre rotação de chaves do Google).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(GOOGLE_JWKS_URL, {
      // 10s timeout pra primeira busca de JWKS — se Google demorar muito,
      // melhor falhar rápido e deixar Pub/Sub re-entregar do que segurar
      // o request por minutos.
      timeoutDuration: 10_000,
      // 1h cooldown entre fetchs forçados quando `kid` desconhecido aparece
      // — evita martelar Google se cliente malicioso enviar `kid` aleatório.
      cooldownDuration: 60 * 60 * 1000,
    });
  }
  return jwks;
}

export interface OidcVerifyOptions {
  /** URL absoluta exata que está como `audience` na subscription Pub/Sub. */
  audience: string;
  /** Email da service account configurada na subscription (claim `email`). */
  expectedEmail: string;
}

export interface VerifiedOidcToken {
  email: string;
  audience: string;
  payload: JWTPayload;
}

export class OidcVerifyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'missing-bearer'
      | 'invalid-signature'
      | 'wrong-issuer'
      | 'wrong-audience'
      | 'wrong-email'
      | 'email-not-verified'
      | 'expired'
      | 'unknown',
  ) {
    super(message);
    this.name = 'OidcVerifyError';
  }
}

/**
 * Valida um Authorization header `Bearer <jwt>` enviado pelo Google Pub/Sub.
 * Em sucesso, retorna o email da service account e o payload completo.
 *
 * Lança `OidcVerifyError` em qualquer falha — caller (endpoint) traduz
 * pra HTTP 401 + log warn.
 */
export async function verifyGoogleOidc(
  authorizationHeader: string | undefined,
  options: OidcVerifyOptions,
): Promise<VerifiedOidcToken> {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    throw new OidcVerifyError('missing Bearer token', 'missing-bearer');
  }
  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw new OidcVerifyError('empty Bearer token', 'missing-bearer');
  }

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getJwks(), {
      issuer: GOOGLE_ISSUER,
      audience: options.audience,
    });
    payload = result.payload;
  } catch (err) {
    const errMsg = (err as Error).message ?? '';
    if (errMsg.includes('audience')) {
      throw new OidcVerifyError(`audience mismatch: ${errMsg}`, 'wrong-audience');
    }
    if (errMsg.includes('issuer')) {
      throw new OidcVerifyError(`issuer mismatch: ${errMsg}`, 'wrong-issuer');
    }
    if (errMsg.includes('exp')) {
      throw new OidcVerifyError(`expired token: ${errMsg}`, 'expired');
    }
    throw new OidcVerifyError(`signature/parse failed: ${errMsg}`, 'invalid-signature');
  }

  const email = typeof payload.email === 'string' ? payload.email : null;
  if (!email) {
    throw new OidcVerifyError('payload missing `email` claim', 'wrong-email');
  }
  if (email !== options.expectedEmail) {
    throw new OidcVerifyError(
      `wrong service account: ${email} != ${options.expectedEmail}`,
      'wrong-email',
    );
  }

  const emailVerified = payload.email_verified;
  if (emailVerified !== true) {
    throw new OidcVerifyError('email_verified claim is not true', 'email-not-verified');
  }

  const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (typeof audience !== 'string') {
    throw new OidcVerifyError('payload missing audience', 'wrong-audience');
  }

  return { email, audience, payload };
}

/** Test-only: limpa o JWKS singleton (reset entre tests com mock fetch). */
export function _resetJwksForTests(): void {
  jwks = null;
}
