# Tinkerton training setup

How Tinkerton's instructions (`agents/tinkerton/AGENTS.md`) were trained and graded.
This folder holds the setup only. The research each case ran on lives in the private
newsroom repository and is not published.

## How it works

Each case is one real assignment from a past edition. A trial wakes Tinkerton on that
assignment, with that day's research and today's newsroom code, and grades the article
he files.

```
train (3 cases)  →  GEPA rewrites the two sections below, 2 rounds
validation (2)   →  picks the best rewrite; the test set is still sealed
test (5 × 4)     →  current vs picked version, 4 repeats per case
```

Only the "Beat guidance" and "Article craft" sections of `AGENTS.md` may change.

## Files

| File | What it is |
|---|---|
| `training.yaml` | Subject model, optimizer, grader, workers and limits |
| `train.yaml`, `validation.yaml`, `test.yaml` | The cases in each set, with the editor's assignment |
| `grading/<case>/case.yaml` | Assignment type, length range and the numbers the story may use |
| `grading/<case>/grader.yaml` | The yes/no questions the grader asks, with expected answers and weights |

## Score

Each article gets a score from 0 to 1:

- **70% questions:** the case's fixed questions, answered by the grader model against
  a private summary of what that day's research established.
- **15% length:** body within the case's word range (evidence markers excluded).
- **15% values in sources:** every number and quote in the article appears in the
  research.

The questions are marked `draft-pending-human-review`: they were written per case and
have not been signed off by an editor.

## Result (2026-10-18)

| Test set, 5 cases × 4 repeats | Before | After |
|---|---|---|
| Total score | 0.739 | 0.830 |
| Questions only | 0.831 | 0.834 |
| Body within 200–400 words | 1 of 20 | 13 of 20 |

All 5 test cases improved. The gain is almost entirely length; question scores did
not move.
