# News body generation prompt

Use the news article at the URL below as the factual source and generate a body for the `POST /news` endpoint.

NEWS_URL: `{{NEWS_URL}}`

## Instructions

- Read the entire source article before writing.
- Write all generated content in English.
- Preserve the source's facts, names, dates, figures, and context. Do not invent information or opinions.
- Paraphrase the article; do not reproduce long passages verbatim.
- Create three self-contained versions of the news story for English learners, in this exact order:
  1. Beginner (CEFR A1-A2): short sentences, common vocabulary, and simple grammar.
  2. Intermediate (CEFR B1-B2): more detail, varied vocabulary, and moderately complex grammar.
  3. Advanced (CEFR C1-C2): nuanced vocabulary, detailed context, and complex but natural grammar.
- Each item in `html` must be a complete article made only from safe semantic HTML. Use `<p>` for paragraphs and, when helpful, `<h2>`, `<ul>`, `<ol>`, `<li>`, `<strong>`, and `<em>`. Do not use Markdown, scripts, styles, images, iframes, or event attributes.
- `difficult_words` must contain exactly three arrays, matching the three `html` versions by index. Include 5 to 10 useful words or short expressions that actually appear in that version and may be difficult for a learner at that level. Use lowercase unless capitalization is required for a proper noun. Do not repeat an entry within the same array.
- `title` must be a non-empty, clear, factual headline.
- `short_description` must be a non-empty summary of the central event and must contain no more than 180 characters, including spaces and punctuation. Count the characters and shorten it before responding if necessary.
- `slug` must be derived from the title and contain only lowercase ASCII letters, numbers, and hyphens. Remove accents and do not add leading or trailing hyphens.
- `links` must contain the supplied source URL. Use the article or publication name as `text`; otherwise use `Original article`.
- `author.name` must contain the source article's byline. If no individual author is shown, use the publication or news agency name. If neither can be identified, use `Unknown`.
- Return valid JSON only. Do not wrap it in a Markdown code block and do not include commentary before or after it.
- Use exactly the keys and value types shown below. Do not add extra keys.

## Validation checklist

Before returning the JSON, silently verify all of the following:

- The root value is an object with exactly these required keys: `title`, `short_description`, `html`, `difficult_words`, `slug`, `links`, and `author`.
- `title` is a non-empty string.
- `short_description` is a non-empty string with at most 180 characters, counting spaces and punctuation.
- `html` is an array containing exactly three non-empty strings in beginner, intermediate, and advanced order.
- `difficult_words` is an array containing exactly three arrays in the same level order. Every entry is a non-empty string and appears in the corresponding `html` string.
- `slug` is a non-empty string matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- `links` is an array whose items contain only `link` and `text`. Each `link` is an absolute, valid URL and each `text` is a non-empty string.
- `author` contains only `name`, and `name` is a non-empty string.
- All JSON strings are correctly escaped. There are no trailing commas, comments, Markdown fences, or additional properties.
- If any check fails, correct the value and run the checklist again before responding.

## Required output shape

{
  "title": "Factual headline",
  "short_description": "Concise summary of the story.",
  "html": [
    "<p>Complete beginner-level version.</p>",
    "<p>Complete intermediate-level version.</p>",
    "<p>Complete advanced-level version.</p>"
  ],
  "difficult_words": [
    ["word used in the beginner version"],
    ["word used in the intermediate version"],
    ["word used in the advanced version"]
  ],
  "slug": "factual-headline",
  "links": [
    {
      "link": "{{NEWS_URL}}",
      "text": "Source name or Original article"
    }
  ],
  "author": {
    "name": "Author, publication, news agency, or Unknown"
  }
}
