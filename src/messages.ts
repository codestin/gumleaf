// All SMS copy. Plain GSM-7: an emoji, curly quote, or degree sign flips the
// message to UCS-2 and cuts segments from 160 to 70 chars.

// Map the common UCS-2 triggers to ASCII so outbound answers stay GSM-7 (halves
// the Twilio cost of a multi-segment reply).
export function toGsm7(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/°/g, "")
    .replace(/ /g, " ");
}

export function welcomeFooter(): string {
  return `You're connected. Text any question and get an answer back by SMS. Reply HELP for info. Not for emergencies - contact emergency services directly.`;
}

export function helpText(): string {
  return `Text any question, get a short answer by SMS. Weather, facts, how-tos. Not for emergencies. STOP to opt out.`;
}

export function capReached(): string {
  return `You've hit this month's answer cap. It resets on the 1st.`;
}

export function moderationRefusal(): string {
  return `Sorry, I can't help with that request. Ask me something else anytime.`;
}

export function crisisResources(): string {
  return `You matter, and you don't have to face this alone. US: call or text 988 (Suicide & Crisis Lifeline). Other countries: findahelpline.com. If you're in immediate danger, contact local emergency services.`;
}

export function emptyBodyHint(): string {
  return `Send me a question or a weather request, e.g. "weather in Oslo". Reply HELP for info.`;
}
