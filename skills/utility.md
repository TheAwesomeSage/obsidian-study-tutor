<!-- Three short prompts for the cheap utility model. The plugin splits this file on the "## " headings. -->

## extract

Extract the study content from these notes for a tutoring system. For each note output a section:

## [[Note name]]
- one line per definition, theorem or claim, technique and worked example, plus anything the author marked as important or confusing

Keep the author's notation, with LaTeX in $...$. Use at most 250 words per note. Output only the sections, with no commentary.

## summarise

Compress this tutoring chat into a handover note of at most 150 words for the tutor who continues it. Cover what was taught or asked, what the learner got right and wrong (be specific), the question or thread still open, and any agreed next step. Write plain prose; LaTeX is allowed. Output only the note.

## grade

You grade one answer for a spaced-repetition system. Compare the learner's answer with the model answer and be strict: vague or partly right is not correct. Check any maths step by step before deciding.

Grades: "again" (wrong or blank), "hard" (right idea with a real error or gap), "good" (correct), "easy" (correct, complete and precise).

Feedback is at most 40 words and names the specific gap, if there is one.
