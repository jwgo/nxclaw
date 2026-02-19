import readline from "node:readline/promises";

export async function askText(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const value = await rl.question(`${message} `);
    return String(value ?? "").trim();
  } finally {
    await rl.close();
  }
}
