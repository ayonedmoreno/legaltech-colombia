import { generateOpaqueToken } from "../../security/crypto.js";
import type { EmailComposers } from "./notifications.types.js";

/** Visible web route (Spanish, PROJECT_SPEC s.39 / D4) that confirms an email address. */
export const EMAIL_VERIFICATION_PATH = "/verificar-correo";

/** Visible web route that sets a new password with the token from a reset email. */
export const PASSWORD_RESET_PATH = "/restablecer-contrasena";

export interface EmailComposerOptions {
  /** The web origin links point to (APP_ORIGIN). */
  appOrigin: string;
  /** How long a verification link stays valid (Sprint 1B, P4a). */
  emailVerificationTokenTtlMs: number;
  /** How long a password reset link stays valid (Sprint 1B, P4b). */
  passwordResetTokenTtlMs: number;
}

function hours(ms: number): number {
  return Math.round(ms / (60 * 60 * 1000));
}

function minutes(ms: number): number {
  return Math.round(ms / (60 * 1000));
}

/**
 * The composer for each kind of email the application sends (Sprint 1B decision C2). A composer
 * that needs a token generates it here, in memory, at dispatch time; only its hash is stored
 * (ADR-002). The token travels in the URL fragment (decision P14): the browser never sends a
 * fragment to any server, and the page posts it to the API in the request body.
 */
export function createEmailComposers(options: EmailComposerOptions): EmailComposers {
  return {
    EMAIL_VERIFICATION: async (entry, scope) => {
      const to = await scope.findUserEmail(entry.userId);
      if (!to) throw new Error("recipient not found");
      const token = generateOpaqueToken();
      const expiresAt = new Date(scope.now.getTime() + options.emailVerificationTokenTtlMs);
      await scope.replaceEmailVerificationToken(entry.userId, token.hash, expiresAt);
      const link = `${options.appOrigin}${EMAIL_VERIFICATION_PATH}#token=${token.raw}`;
      return {
        to,
        subject: "Verifica tu correo electrónico",
        text:
          "Hola:\n\n" +
          "Para verificar tu correo electrónico, abre este enlace:\n\n" +
          `${link}\n\n` +
          `El enlace caduca en ${hours(options.emailVerificationTokenTtlMs)} horas y solo sirve una vez. ` +
          "Si no creaste una cuenta, ignora este mensaje.\n",
      };
    },
    PASSWORD_RESET: async (entry, scope) => {
      const to = await scope.findUserEmail(entry.userId);
      if (!to) throw new Error("recipient not found");
      const token = generateOpaqueToken();
      const expiresAt = new Date(scope.now.getTime() + options.passwordResetTokenTtlMs);
      await scope.replacePasswordResetToken(entry.userId, token.hash, expiresAt);
      const link = `${options.appOrigin}${PASSWORD_RESET_PATH}#token=${token.raw}`;
      return {
        to,
        subject: "Restablece tu contraseña",
        text:
          "Hola:\n\n" +
          "Recibimos una solicitud para restablecer la contraseña de tu cuenta. " +
          "Para elegir una nueva, abre este enlace:\n\n" +
          `${link}\n\n` +
          `El enlace caduca en ${minutes(options.passwordResetTokenTtlMs)} minutos y solo sirve una vez. ` +
          "Si no lo solicitaste, ignora este mensaje: tu contraseña no cambiará.\n",
      };
    },
    // ADR-002: "Al restablecer la contraseña … se notifica por email". Carries no token.
    PASSWORD_RESET_COMPLETED: async (entry, scope) => {
      const to = await scope.findUserEmail(entry.userId);
      if (!to) throw new Error("recipient not found");
      return {
        to,
        subject: "Tu contraseña se ha cambiado",
        text:
          "Hola:\n\n" +
          "La contraseña de tu cuenta se acaba de cambiar y todas tus sesiones se han cerrado.\n\n" +
          "Si no fuiste tú, restablece tu contraseña de inmediato.\n",
      };
    },
  };
}
