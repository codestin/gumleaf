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

// Hard net against runaway model output: the prompt aims for ~450 chars, this
// clamp guarantees a reply never exceeds ~4 concatenated GSM-7 segments.
export const SMS_HARD_CAP = 640;

export function clampSms(text: string, max: number = SMS_HARD_CAP): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3).trimEnd() + "...";
}

export function welcomeFooter(): string {
  return `You're connected. Text any question and get an answer back by SMS. Reply HELP for info. Not for emergencies - contact emergency services directly.`;
}

export function helpText(): string {
  return `Text any question, get a short answer by SMS. Weather (with sunrise/sunset), facts, how-tos. Live data: BART <station>, CALTRAIN <stop>, FLIGHT UA123 (add a date: FLIGHT SK936 on 7/24). Not for emergencies. STOP to opt out.`;
}

// Companion text for the contact-card MMS (sent on first contact and for the
// CONTACT/VCARD/CARD/SAVE keyword when VCARD_URL is configured).
export function vcardIntro(): string {
  return `PS - save my contact card while you still have bars. Out past the trailhead, a name is a lot easier to find than a number you don't recognize.`;
}

export function vcardKeywordReply(): string {
  return `Here I come as a contact card - one sec.`;
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
