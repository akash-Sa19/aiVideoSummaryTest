import youtubedl from "youtube-dl-exec";
import ffmpeg from "fluent-ffmpeg";
import { OpenAI } from "openai";
import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";
import {
  fullTranscript,
  originalExtractFiveMinuteExcerpts,
  responseChoises0,
  responseFromOpenAi,
} from "./rawData.js";

dotenv.config({
  path: "./.env",
});

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const mainCategories = [
  "AI",
  "Technology",
  "Business",
  "Science",
  "Health",
  "Education",
  "Entertainment",
  "Sports",
  "Politics",
  "Environment",
];

// working perfectly
async function getVideoInfo(videoUrl) {
  try {
    const info = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      format: "bestaudio/best",
      noWarnings: true,
      quiet: true,
    });

    return {
      video_url: videoUrl,
      title: info.title || "",
      description: info.description || "",
      thumbnail: info.thumbnail || "",
      channel_name: info.uploader || "",
      upload_date: info.upload_date || "",
    };
  } catch (error) {
    console.error("Error retrieving video info:", error);
  }
}

// console.log(await getVideoInfo("https://www.youtube.com/watch?v=6xKWiCMKKJg"));

async function downloadAudio(youtubeUrl) {
  const outputPath = "temp_audio.mp3";
  await youtubedl(youtubeUrl, {
    extractAudio: true,
    audioFormat: "mp3",
    audioQuality: 192,
    output: outputPath,
  });
  return outputPath;
}
// console.log(
//   await downloadAudio("https://youtu.be/Bzp6ejs_leQ?si=vqu1OD5Kkzeal5CP")
// );

function splitAudio(audioFile, targetChunkSizeMB = 25) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioFile, (err, metadata) => {
      if (err) return reject(err);

      // console.log("metadata -> ", metadata);

      const totalBytes = metadata.format.size;
      console.log("Total bytes:", totalBytes);
      const totalMB = totalBytes / (1024 * 1024);
      console.log("Total MB:", totalMB);

      const numChunks = Math.ceil(totalMB / targetChunkSizeMB);
      console.log("Number of chunks:", numChunks);
      const chunkLengthMs = (metadata.format.duration * 1000) / numChunks;
      console.log("Chunk length in ms:", chunkLengthMs);

      let chunks = [];
      let promises = [];

      for (let i = 0; i < numChunks; i++) {
        const start = (i * chunkLengthMs) / 1000; // in seconds
        const chunkName = `temp_chunk_${i}.mp3`;

        promises.push(
          new Promise((res, rej) => {
            ffmpeg(audioFile)
              .setStartTime(start)
              .setDuration(chunkLengthMs / 1000)
              .output(chunkName)
              .on("end", () => {
                chunks.push(chunkName);
                res();
              })
              .on("error", rej)
              .run();
          })
        );
      }

      Promise.all(promises)
        .then(() => resolve(chunks))
        .catch(reject);
    });
  });
}

console.log(
  "splitAudio result -> ",
  await splitAudio(
    await downloadAudio("https://youtu.be/Bzp6ejs_leQ?si=vqu1OD5Kkzeal5CP")
  )
);

async function transcribeAudio(audioFile) {
  try {
    const chunks = await splitAudio(audioFile);
    let transcripts = [];

    for (let chunk of chunks) {
      const audioData = fs.createReadStream(chunk);

      const response = await openaiClient.audio.transcriptions.create({
        file: audioData,
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });

      console.log(response);
      transcripts.push(response);
      fs.unlinkSync(chunk); // Remove temporary chunk file
    }

    console.log("transcripts -> ", transcripts);
    return transcripts;
  } catch (error) {
    console.error("Error transcribing audio:", error);
  }
}

// console.log(
//   await transcribeAudio(
//     await downloadAudio(
//       "https://youtube.com/shorts/W8ZEd-vXZfE?si=Y07leqalF16-22ey"
//     )
//   )
// );

function combineTranscripts(transcripts) {
  let fullTranscript = {
    text: "",
    segments: [],
  };

  let currentStart = 0;

  for (let t of transcripts) {
    fullTranscript.text += t.text + " ";

    for (let segment of t.segments) {
      let segmentStart = currentStart + segment.start;
      let segmentEnd = currentStart + segment.end;

      fullTranscript.segments.push({
        start: segmentStart,
        end: segmentEnd,
        text: segment.text,
      });
    }

    currentStart += t.segments[t.segments.length - 1].end;
  }

  return fullTranscript;
}
// console.log(combineTranscripts([responseFromOpenAi]));

async function extractFiveMinuteExcerpts(segments, videoId) {
  let excerpts = [];
  let currentExcerpt = { start: 0, end: 0, text: "" };
  let videoInfo = await getVideoInfo(videoId);

  for (let segment of segments) {
    let segmentStart = segment.start;
    let segmentEnd = segment.end;
    let segmentText = segment.text;

    // Check if a new 5-minute period has started
    if (
      Math.floor(segmentStart / 300) > Math.floor(currentExcerpt.start / 300)
    ) {
      if (currentExcerpt.text) {
        Object.assign(currentExcerpt, videoInfo);
        excerpts.push(currentExcerpt);
      }
      currentExcerpt = {
        start: segmentStart,
        end: segmentEnd,
        text: segmentText,
      };
    } else {
      currentExcerpt.end = segmentEnd;
      currentExcerpt.text += " " + segmentText;
    }

    // Check if the 5-minute period has ended
    if (Math.floor(segmentEnd / 300) > Math.floor(currentExcerpt.start / 300)) {
      Object.assign(currentExcerpt, videoInfo);
      excerpts.push(currentExcerpt);
      currentExcerpt = { start: segmentEnd, end: segmentEnd, text: "" };
    }
  }

  // Push the last excerpt if it has content
  if (currentExcerpt.text) {
    Object.assign(currentExcerpt, videoInfo);
    excerpts.push(currentExcerpt);
  }

  return excerpts;
}

// console.log(
//   await extractFiveMinuteExcerpts(fullTranscript.segments, "W8ZEd-vXZfE")
// );

function defineExtractSnippetsFunction() {
  return {
    name: "extract_snippets",
    description:
      "Extract valuable snippets and additional information from a transcript chunk",
    parameters: {
      type: "object",
      properties: {
        snippets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              snippet: {
                type: "string",
                description:
                  "Exact quote, not more than 400-600 characters from the transcript with minimal rephrasing to make the text sound consistent, complete, and grammatically correct. Use square brackets for rephrased sections.",
              },
              snippet_title: {
                type: "string",
                description:
                  "A 4-8 words SEO-optimized, catchy title for the snippet. Include big personalities' names if applicable.",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "2-3 relevant tags for the snippet",
              },
              main_category: {
                type: "string",
                description: `The main category of the snippet chosen from: ${mainCategories}`,
              },
              ideas: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of top ideas extracted from the transcript with best practices or expert advice. If not applicable, return an empty list.",
              },
              opportunities: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of business opportunities, market gaps, or trends. Return an empty list if none.",
              },
              problems: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of challenges or pain points mentioned. Return an empty list if none.",
              },
              tools: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of tools, software, platforms mentioned. Return an empty list if none.",
              },
            },
            required: [
              "snippet",
              "tags",
              "main_category",
              "ideas",
              "opportunities",
              "problems",
              "tools",
            ],
          },
        },
      },
      required: ["snippets"],
    },
  };
}

async function extractSnippetsFromExcerpt(excerpt, startTime, videoUrl) {
  const tools = [defineExtractSnippetsFunction()];

  const messages = [
    {
      role: "system",
      content: `
        You are an expert analyst and value spotter who specializes in extracting high value insights from a given text.
        You are strict about only picking valuable insights and will return 'None' if there are none.
        
        Provide:
        1. A brief summary
        2. Top ideas, opportunities, problems, and tools (or empty list if not applicable)
      `,
    },
    {
      role: "user",
      content: `
        Extract a maximum of 1 or 2 valuable snippets from this 5-minute excerpt:
        ${excerpt}
        
        - Avoid introductory or concluding statements.
        - Use the main category carefully from the list: ${mainCategories}
      `,
    },
  ];

  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      functions: tools,
      function_call: "auto",
    });

    console.log("response ->", response);
    console.log("response.choises[0].message ->", response.choices[0].message);

    const functionCall = response.choices[0].message.function_call;
    if (functionCall && functionCall.arguments) {
      const parsedArguments = JSON.parse(functionCall.arguments);
      const snippets = parsedArguments.snippets;

      // Add timestamp URL to each snippet if snippets are available
      if (Array.isArray(snippets)) {
        snippets.forEach((snippet) => {
          snippet.timestamp_url = `${videoUrl}&t=${Math.floor(startTime)}`;
        });
        return snippets;
      } else {
        console.error(
          "No snippets found in the parsed function call arguments."
        );
      }
    } else {
      console.error(
        "No function call found or invalid function call format in the response."
      );
    }
  } catch (error) {
    console.error("Error extracting snippets:", error);
  }
}
// console.log(
//   "extractSnippetsFromExcerpt -> ",
//   await extractSnippetsFromExcerpt(
//     originalExtractFiveMinuteExcerpts[0].text,
//     originalExtractFiveMinuteExcerpts[0].start,
//     originalExtractFiveMinuteExcerpts[0].url
//   )
// );

// console.log(await JSON.parse(responseChoises0.function_call.arguments));

async function generateSmartSummary(transcript) {
  const prompt = `
    Analyze the following video transcript and create a structured and smart summary.
    The summary should include subtopics with their own short titles (##),
    paragraphs explaining key points, and bullet lists for important details.

    Don't refer to the "transcript" in the summary.
    Keep the focus on the content only and never on the metadata.

    --------
    Transcript:
    ${transcript}
    --------
  `;

  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are an expert in creating structured summaries from video transcripts.",
        },
        { role: "user", content: prompt },
      ],
    });

    console.log("generateSmartSummary/line:415 ->", response);
    console.log("generateSmartSummary/line:415 ->", response.choices[0]);

    const smartSummary = response.choices[0].message.content;
    return smartSummary;
  } catch (error) {
    console.error("Error generating smart summary:", error);
  }
}

// console.log(
//   await generateSmartSummary(originalExtractFiveMinuteExcerpts[0].text)
// );
