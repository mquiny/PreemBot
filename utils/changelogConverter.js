function convertChangelogToNexusMarkdownFromEmbeds(embeds) {
  let out = "";
  for (const embed of embeds) {
    if (embed.title) out += `### ${embed.title}\n\n`;
    if (embed.description) {
      // Replace Discord bullets "•" with markdown "-" and ensure blank lines above exclusives
      let desc = embed.description
        .replace(/^•/gm, "-")
        .replace(/\n\*\*(.*?)\*\*:/g, "\n\n**$1:**"); // Ensure exclusives have a blank line before
      out += desc + "\n\n";
    }
  }
  return out.trim();
}
module.exports = { convertChangelogToNexusMarkdownFromEmbeds };
