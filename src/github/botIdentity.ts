export function formatBotDisplayName(value: string | undefined): string {
  const trimmed = value?.trim().replace(/^@/, "");
  if (!trimmed || trimmed.toLowerCase() === "ghbot") {
    return "goose";
  }
  const botLogin = /^(.*?)\[bot\]$/i.exec(trimmed);
  return botLogin?.[1]?.trim() ? `${botLogin[1].trim()} bot` : trimmed;
}
