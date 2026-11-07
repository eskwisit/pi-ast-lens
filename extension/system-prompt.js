// Adds a plugin section to the system prompt of one provider request, in place.
//
// Why the request and not before_agent_start: PI-Desktop stores a changed system prompt as a new
// system message. On providers that take system messages in the conversation (Anthropic), the
// model then gets the whole prompt twice, in each later request. The request payload is built for
// each call and is never stored, so a section added here costs its own size only.
//
// Payload shapes of the PI-Desktop provider adapters:
// - Anthropic Messages: system, a string or an array of text blocks. With OAuth, block 0 is the
//   Claude Code line and the last block is the PI-Desktop prompt.
// - OpenAI Codex Responses: instructions, a string.
// - Google Gemini and Vertex: systemInstruction, a string or { parts: [{ text }] }.
// - OpenAI Chat Completions and Mistral: messages[0] with role system or developer.
// - OpenAI and Azure Responses: input[0] with role system or developer.

const SYSTEM_ROLES = new Set(["system", "developer"]);
const TEXT_TYPES = new Set([undefined, "text", "input_text"]);

function join(text, section, at) {
	return at === "start" ? `${section}\n\n${text}` : `${text}\n\n${section}`;
}

// Edits holder[key] when it is a string or an array of text parts. Returns false for other shapes.
function addTo(holder, key, section, at) {
	const value = holder[key];
	if (typeof value === "string") {
		if (!value.includes(section)) holder[key] = join(value, section, at);
		return true;
	}
	if (!Array.isArray(value)) return false;
	const parts = value.filter((p) => p && typeof p === "object" && typeof p.text === "string" && TEXT_TYPES.has(p.type));
	if (!parts.length) return false;
	if (parts.some((p) => p.text.includes(section))) return true;
	// The last text part: the PI-Desktop prompt, also when a provider puts a fixed line before it.
	const part = parts[parts.length - 1];
	part.text = join(part.text, section, at);
	return true;
}

/**
 * Adds section to the system prompt in payload, in place. Does nothing when the section is
 * already there, so a retried request does not get it twice.
 * @param {object} payload provider request body (before_provider_request event.payload)
 * @param {string} section text to add
 * @param {"start" | "end"} at start or end of the PI-Desktop prompt
 * @returns {boolean} true when the payload has a system prompt that holds the section
 */
export function addToSystemPrompt(payload, section, at = "end") {
	if (!payload || typeof payload !== "object" || typeof section !== "string" || !section) return false;
	if (payload.system !== undefined) return addTo(payload, "system", section, at);
	if (typeof payload.instructions === "string") return addTo(payload, "instructions", section, at);
	const si = payload.systemInstruction;
	if (si !== undefined) {
		return si && typeof si === "object" && Array.isArray(si.parts) ? addTo(si, "parts", section, at) : addTo(payload, "systemInstruction", section, at);
	}
	for (const key of ["messages", "input"]) {
		const first = Array.isArray(payload[key]) ? payload[key][0] : undefined;
		if (first && typeof first === "object" && SYSTEM_ROLES.has(first.role)) return addTo(first, "content", section, at);
	}
	return false;
}
