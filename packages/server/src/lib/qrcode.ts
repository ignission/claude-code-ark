/**
 * QR Code Generator for Terminal
 *
 * Generates QR codes that can be displayed in the terminal.
 * Uses qrcode package with terminal output.
 */

import QRCode from "qrcode";

/**
 * Generate QR code as terminal string
 */
export async function generateQRCode(url: string): Promise<string> {
  try {
    const qr = await QRCode.toString(url, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "L",
    });
    return qr;
  } catch (error) {
    throw new Error(`Failed to generate QR code: ${error}`);
  }
}

/**
 * Print QR code and URL to terminal with nice formatting
 */
export async function printRemoteAccessInfo(
  url: string,
  token?: string
): Promise<void> {
  const separator = "═".repeat(50);

  console.log("\n");
  console.log(`╔${separator}╗`);
  console.log(`║${"  REMOTE ACCESS ENABLED".padEnd(50)}║`);
  console.log(`╠${separator}╣`);
  console.log(`║${"".padEnd(50)}║`);

  // Generate and print QR code
  try {
    const qr = await generateQRCode(url);
    const lines = qr.split("\n");
    for (const line of lines) {
      console.log(`║  ${line}`);
    }
  } catch {
    console.log(`║${"  [QR Code generation failed]".padEnd(50)}║`);
  }

  console.log(`║${"".padEnd(50)}║`);
  console.log(`╠${separator}╣`);
  console.log(`║${"  Scan QR code or open URL:".padEnd(50)}║`);
  console.log(`║${"".padEnd(50)}║`);

  // Print URL (may be longer than 50 chars)
  const urlParts = url.match(/.{1,46}/g) || [url];
  for (const part of urlParts) {
    console.log(`║  ${part.padEnd(48)}║`);
  }

  if (token) {
    console.log(`║${"".padEnd(50)}║`);
    console.log(`╠${separator}╣`);
    console.log(`║${"  Auth Token (keep secret):".padEnd(50)}║`);
    console.log(`║  ${token.padEnd(48)}║`);
  }

  console.log(`║${"".padEnd(50)}║`);
  console.log(`╚${separator}╝`);
  console.log("\n");
}
