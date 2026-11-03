// Claude on Amazon Bedrock, in SOI's own AWS account — the only AI the
// tracker uses. Same credentials and region as S3 (s3store.js): the host's
// IAM role, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. Never Anthropic's
// own API, and no keys in the repo.
//
// BEDROCK_MODEL_ID picks the model (default Claude Sonnet 5.5,
// "anthropic.claude-sonnet-5-5"). BEDROCK_REGION overrides AWS_REGION if
// the model isn't offered in the bucket's region.
//
// The AWS admin has to (1) enable the Anthropic model under Bedrock → Model
// access in that region, and (2) allow bedrock:InvokeModel on it for the
// role the tracker runs as. explainError() says which one is missing.

const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const MODEL_ID = process.env.BEDROCK_MODEL_ID || "anthropic.claude-sonnet-5-5";
const REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

let client = null;
function bedrock() {
  if (!client) client = new BedrockRuntimeClient({ region: REGION });
  return client;
}

class AiError extends Error {
  constructor(message) {
    super(message);
  }
}

// What the AWS admin has to change, in plain words.
function explainError(err) {
  const name = (err && err.name) || "";
  const msg = String((err && err.message) || "");
  const status = err && err.$metadata ? err.$metadata.httpStatusCode : 0;
  if (name === "AccessDeniedException" && /model access|don't have access to the model|not authorized to access this model/i.test(msg)) {
    return `Claude isn't switched on in SOI's AWS account yet. The AWS admin needs to enable ${MODEL_ID} under Amazon Bedrock → Model access in ${REGION}.`;
  }
  if (name === "AccessDeniedException" || status === 403) {
    return `The tracker's AWS role isn't allowed to use Claude on Bedrock. The AWS admin needs to allow bedrock:InvokeModel on arn:aws:bedrock:${REGION}::foundation-model/${MODEL_ID} for the role the tracker runs as (e.g. EC2S3AccessRole), and enable the model under Bedrock → Model access.`;
  }
  if (name === "ResourceNotFoundException" || (name === "ValidationException" && /model identifier|model id|on-demand throughput|inference profile/i.test(msg))) {
    return `Bedrock in ${REGION} doesn't offer ${MODEL_ID}. Set BEDROCK_MODEL_ID (or BEDROCK_REGION) on the stack to a model and region SOI's account has. Bedrock said: ${msg.slice(0, 200)}`;
  }
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException" || status === 429) return "Bedrock is busy right now. Try again in a minute.";
  if (name === "CredentialsProviderError" || /credential/i.test(msg)) return "The tracker has no AWS credentials for Bedrock (same as S3: an IAM role on the host, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).";
  return `Bedrock didn't answer (${name || status || "error"}${msg ? ": " + msg.slice(0, 200) : ""}).`;
}

/**
 * One request to Claude: system prompt + one user message. Returns the text
 * of the answer. Throws AiError with a plain-words reason.
 */
async function askClaude({ system, user, maxTokens }) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens || 8000,
    system,
    messages: [{ role: "user", content: user }],
  };
  let out;
  try {
    const res = await bedrock().send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    }));
    out = JSON.parse(Buffer.from(res.body).toString("utf8"));
  } catch (err) {
    console.error(`Bedrock ${MODEL_ID} in ${REGION} failed:`, err.name, err.message);
    throw new AiError(explainError(err));
  }
  if (out.stop_reason === "refusal") throw new AiError("Claude declined to draft this one. Write the reply yourself.");
  const text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new AiError("Claude returned an empty draft. Try again.");
  return { text, truncated: out.stop_reason === "max_tokens", model: MODEL_ID };
}

module.exports = { askClaude, AiError, BEDROCK_MODEL_ID: MODEL_ID, BEDROCK_REGION: REGION };
