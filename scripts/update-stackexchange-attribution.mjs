import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = resolve(
  repositoryRoot,
  "third_party/stackexchange-video-qa/data/video-qa.jsonl",
);
const outputPath = resolve(
  repositoryRoot,
  "third_party/stackexchange-video-qa/sources.jsonl",
);
const manualSourcesPath = resolve(
  repositoryRoot,
  "third_party/stackexchange-video-qa/manual-sources.json",
);
const API_ROOT = "https://api.stackexchange.com/2.3";
const SITE = "stackoverflow";
// The API occasionally omits `content_license` from very large multi-id
// responses even though the same post includes it in a smaller response.
// Twenty keeps the attribution fields complete while staying well within the
// anonymous daily request quota for this corpus.
const BATCH_SIZE = 20;

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON in ${path} on line ${index + 1}`, { cause: error });
      }
    });
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function pause(milliseconds) {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

async function fetchPosts(kind, ids) {
  const items = [];
  for (const batch of chunks(ids, BATCH_SIZE)) {
    const url = new URL(`${API_ROOT}/${kind}/${batch.join(";")}`);
    url.searchParams.set("site", SITE);
    url.searchParams.set("pagesize", String(BATCH_SIZE));
    if (process.env.STACK_EXCHANGE_KEY) {
      url.searchParams.set("key", process.env.STACK_EXCHANGE_KEY);
    }

    const response = await fetch(url, {
      headers: { "User-Agent": "MpVFX-attribution-maintainer/1.0" },
    });
    if (!response.ok) {
      throw new Error(`Stack Exchange API ${response.status} for ${kind} batch`);
    }
    const body = await response.json();
    if (body.error_message) {
      throw new Error(`Stack Exchange API: ${body.error_message}`);
    }
    items.push(...(body.items ?? []));
    if (Number.isFinite(body.backoff) && body.backoff > 0) {
      await pause(body.backoff * 1000);
    }
  }
  return items;
}

async function retryIncompletePosts(kind, items, idField) {
  const completed = [];
  for (const item of items) {
    if (typeof item.content_license === "string") {
      completed.push(item);
      continue;
    }
    const postId = item[idField];
    const [retried] = await fetchPosts(kind, [postId]);
    completed.push(retried ?? item);
  }
  return completed;
}

function licenseUrl(license) {
  const match = /^CC BY-SA (2\.5|3\.0|4\.0)$/u.exec(license ?? "");
  if (!match) throw new Error(`Unsupported or missing content license: ${license}`);
  return `https://creativecommons.org/licenses/by-sa/${match[1]}/`;
}

function isoDate(unixSeconds) {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) {
    throw new Error(`Invalid contribution date: ${unixSeconds}`);
  }
  return new Date(unixSeconds * 1000).toISOString();
}

function attributionRecord({ item, postType, questionId, questionTitle }) {
  const postId = postType === "question" ? item.question_id : item.answer_id;
  if (!Number.isSafeInteger(postId)) throw new Error(`Missing ${postType} ID in API response`);
  if (typeof item.content_license !== "string") {
    throw new Error(`Missing content license for ${postType}:${postId}`);
  }
  const sourceUrl =
    typeof item.link === "string" && item.link.startsWith("https://stackoverflow.com/")
      ? item.link
      : postType === "question"
        ? `https://stackoverflow.com/questions/${postId}`
        : `https://stackoverflow.com/a/${postId}`;
  const author = item.owner?.display_name?.trim() || "user deleted";

  return {
    post_id: postId,
    post_type: postType,
    question_id: questionId,
    question_title: questionTitle,
    author,
    author_url: item.owner?.link ?? null,
    source_url: sourceUrl,
    created_at: isoDate(item.creation_date),
    license: item.content_license,
    license_url: licenseUrl(item.content_license),
    changes: "Reformatted as JSONL for QA research; source HTML is retained in the corpus.",
  };
}

const corpus = readJsonLines(corpusPath);
const manualSources = JSON.parse(readFileSync(manualSourcesPath, "utf8"));
if (!Array.isArray(manualSources)) {
  throw new Error(`${manualSourcesPath} must contain a JSON array`);
}
const manualById = new Map(
  manualSources.map((source) => [`${source.post_type}:${source.post_id}`, source]),
);
const questionIds = corpus.map((record) => record.question_id);
const answerIds = corpus.flatMap((record) => record.answers.map((answer) => answer.answer_id));
const [questionBatch, answerBatch] = await Promise.all([
  fetchPosts("questions", questionIds),
  fetchPosts("answers", answerIds),
]);
const [questions, answers] = await Promise.all([
  retryIncompletePosts("questions", questionBatch, "question_id"),
  retryIncompletePosts("answers", answerBatch, "answer_id"),
]);
const questionById = new Map(questions.map((item) => [item.question_id, item]));
const answerById = new Map(answers.map((item) => [item.answer_id, item]));
const missing = [];
const records = [];

for (const source of corpus) {
  const question = questionById.get(source.question_id);
  if (!question) {
    const key = `question:${source.question_id}`;
    const manual = manualById.get(key);
    if (manual) records.push(manual);
    else missing.push(key);
    continue;
  }
  const title = question.title || source.title;
  records.push(
    attributionRecord({
      item: question,
      postType: "question",
      questionId: source.question_id,
      questionTitle: title,
    }),
  );
  for (const sourceAnswer of source.answers) {
    const answer = answerById.get(sourceAnswer.answer_id);
    if (!answer) {
      const key = `answer:${sourceAnswer.answer_id}`;
      const manual = manualById.get(key);
      if (manual) records.push(manual);
      else missing.push(key);
      continue;
    }
    records.push(
      attributionRecord({
        item: answer,
        postType: "answer",
        questionId: source.question_id,
        questionTitle: title,
      }),
    );
  }
}

const corpusKeys = new Set(
  corpus.flatMap((source) => [
    `question:${source.question_id}`,
    ...source.answers.map((answer) => `answer:${answer.answer_id}`),
  ]),
);
for (const key of manualById.keys()) {
  if (!corpusKeys.has(key)) {
    throw new Error(`Manual attribution does not correspond to a retained corpus post: ${key}`);
  }
}

if (missing.length > 0) {
  throw new Error(
    `The official API did not return ${missing.length} retained posts:\n${missing.join("\n")}`,
  );
}

writeFileSync(outputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
console.log(`Wrote ${records.length} complete attribution records to ${outputPath}`);
