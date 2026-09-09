// services/spam/rules/suspiciousPatterns.js
//
// Catches a single scam/phishing message in one channel -- the case none of
// the other rules cover, since they all look at BEHAVIOR (posting in many
// channels, posting fast, posting lots of images) rather than the content
// of one message. A crypto wallet-drainer link or a "free nitro" message
// posted once, in one channel, from an account that otherwise looks
// unremarkable, won't trip multiChannelSpam/rapidPosting/imageSpam at all.
//
// Deliberately always deleteOnly: true (see SpamActionHandler's
// applyAutomaticAction) -- a plain keyword/phrase match is far more likely
// to produce a false positive than a behavioral rule is (a member
// genuinely discussing "crypto" or "airdrop" trips the same match a
// scammer's copy-pasted message does), so the automatic action for this
// rule alone is capped at "delete the message and flag it for a mod,"
// never a timeout or ban. Worst case for a false positive is one deleted
// message, not a wrongly-timed-out member.
const { RULE_DEFAULTS } = require('../spamConfigResolver');

function normalize(text, caseSensitive) {
  return caseSensitive ? text : text.toLowerCase();
}

module.exports = function suspiciousPatternsRule(message, config = {}, activityStats) {
  if (!config || config.enabled !== true) return { triggered: false };

  const ruleConfig = { ...RULE_DEFAULTS.suspiciousPatterns, ...config };
  const patterns = Array.isArray(ruleConfig.patterns) ? ruleConfig.patterns : [];
  if (patterns.length === 0) return { triggered: false };

  const content = message.content || '';
  if (!content.trim()) return { triggered: false };

  // Trust established members with a long clean history in this server --
  // set minMessagesExempt to 0 in config to disable this exemption entirely.
  const minMessagesExempt = Number(ruleConfig.minMessagesExempt ?? RULE_DEFAULTS.suspiciousPatterns.minMessagesExempt);
  if (minMessagesExempt > 0 && (activityStats?.messages ?? 0) >= minMessagesExempt) {
    return { triggered: false };
  }

  const caseSensitive = Boolean(ruleConfig.caseSensitive);
  const haystack = normalize(content, caseSensitive);

  const matched = patterns.find((pattern) => {
    if (typeof pattern !== 'string' || !pattern.trim()) return false;
    return haystack.includes(normalize(pattern, caseSensitive));
  });

  if (!matched) return { triggered: false };

  return {
    triggered: true,
    ruleName: 'Suspicious Pattern',
    severity: 'critical',
    score: 3,
    deleteOnly: true,
    evidence: [{
      messageId: message.id,
      channelId: message.channelId,
      content: content.substring(0, 100),
      attachments: Array.from(message.attachments?.values?.() || []).map((a) => ({ url: a.url, name: a.name }))
    }],
    description: `Message matched known scam phrase: "${matched}"`
  };
};
