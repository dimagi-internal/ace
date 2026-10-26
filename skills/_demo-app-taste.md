# Demo app taste (`_demo-app-taste.md`)

Reference document, **not a skill**. The leading `_` keeps it out of the skill catalog. Two skills
read it: `demo-app-critique` judges an app against it, and `demo-app-makeover` builds to it.

It records what a demo-ready Connect app looks like, in the words of the person whose judgment
set it: **Lily Olson**, Dimagi's demo lead. The source is one working session on 2026-10-26, in
which she and ACE turned the production Learn Kangaroo Care app into a demo version in the EU
`connect-demo` project space. That took 11 builds and about 40 notes from her. Each rule below
comes from one of those notes. Quotes are hers, and **Seen as** gives the KC case that taught it.

The rules apply to **any** app being made demo-ready, Learn or Deliver. KC is the worked example,
not the scope. When a later reviewer's note contradicts a rule here, the newer note wins: update
this file and record the change in `demo-app-makeover`'s Change Log.

## The one-line test

> Would a funder watching over a community health worker's shoulder think "this is simple, it
> teaches, and it was made for this worker"?

Every rule below serves one of those three. A demo is judged in seconds, on a phone, by someone
who has never seen the app. Clunky, wordy or off-audience screens cost more in a demo than in
production, because no one is there to explain them.

## 1. Write for the worker, not the protocol

The worker is a community health worker in rural Uganda, Kenya or Nigeria. *"The content should
reflect that user's level of education and vocabulary."*

- **Plain words over clinical or program jargon.** Spell out or replace every acronym. *Seen
  as:* "SVN" was used 16 times and never defined, so it became "baby", not "infant". "KMC" became
  "KC" everywhere a worker reads it. A screen that opened on "Etymology" was cut: *"doesn't
  resonate at all."*
- **Use one word for one thing across the app.** If the Learn content says "baby", the test,
  the referral guide and the exit criteria say "baby" too.
- **US spelling** (`_terminology.md`): enrollment, counseling, immunizations.
- **Keep only what's essential to deliver the service correctly.** Cut textbook definitions and
  history. Rewrite test questions that check wording rather than practice in plain words, or drop
  them.

## 2. A home screen that fits on one look

- **Six modules at most.** *"Limiting to a max of 6 modules would be better."*
- **Short names that fit on one line of the tile.** *"Shortening module names so they appear on
  the screen … is essential."*
- **Name each module for what the worker does or gets, in everyday words.** Her renames, in
  order, show the direction:

  | Production name | Demo name | Why |
  |---|---|---|
  | Pre-Learn Test | Starting Quiz | "This is a weird name" |
  | Post-Learn Test | Get Certified | names the reward, not the mechanism |
  | Learn about KMC → Learn about KC | Kangaroo Care Basics | plain, no acronym |
  | Learn Module (menu) | Learn about Kangaroo Care | says what is inside |
  | Tips to capture weight photograph | Weight Photo Tips → Photographing the Scale → Photographing Baby's Weight | names the worker's action and its object |
  | Troubleshooting Common Concerns | Common Questions → Answering Family Concerns → Counseling Families | "Troubleshooting" read as app help; the final name is the worker's role |
  | KC Discontinuation Criteria | Ending Home Visits | the worker's action, not a clinical criterion |

  Expect several rounds on names. Make a rename cheap: change every place the name appears (see
  `demo-app-makeover` § Renames).
- **Order modules for the story.** Put the most compelling module high (*"This is a cool module
  … should be higher on the screen"*). Put the closing module last (Ending Home Visits). The
  certification step comes after all of them.

## 3. Nothing clunky: seamless or gone

- **Remove modules that exist only to set up the system.** *"Instructions for chatbot: this
  module is horrible and should be removed. This makes our app look so clunky … It should be
  seamless or it doesn't belong."* Move the setup into something the worker already does: the
  chatbot sign-up flag moved into the Starting Quiz.
- **Remove repeated content.** Merge or cut a module whose difference from another isn't
  obvious. *"How is this different from the Learn about KMC module content above?"* Mantras and
  Counselling were removed, and their useful points folded in.
- **Never promise a step the worker can't take yet.** *"I'm told to proceed to a test but then
  I'm taken back to the homescreen where no test is visible."* A prompt appears only when the
  action is unlocked, and the prompt and the unlock rule must agree.
- **End-of-form navigation returns the worker to where they were working,** the module list
  rather than the home screen, so the next module is one tap away.

## 4. Every screen earns its place

- **Every screen has an image or formatting that breaks up the text.** *"This content is very
  text heavy. Every screen should have an image or some formatting to break up the text."* Use
  bullets, not numbers, for lists. Bold the one fact on the screen that matters.
- **Each screen has its own header.** *"The white header text is an opportunity to visually
  distinguish between screens"*. Don't repeat the same title on every screen.
- **Open each module with one framing line:** what this module is for, in the worker's terms.
  *Seen as:* "Families often have questions or concerns about Kangaroo Care that you can help
  address…"; "There are several circumstances that should lead you to end home visits to a
  family. They include:".
- **Introduce a screen before its example.** "What photo should you capture?" comes before the
  example photograph.
- **Tell the worker what a baseline quiz is for.** The Starting Quiz opens by saying it only
  checks what they already know, and that the score doesn't stop them going on to learn.
- **Split a screen that does two jobs.** Referral became two screens: (1) "If a baby is showing a
  danger sign, it is essential that you refer…" with the danger-signs image, then (2) the
  referral steps as bullets.

## 5. Teach, don't mention

*"I want to make sure the learn app really teaches, not just that it briefly mentions the right
information."*

- **Teach every fact the certification test checks on a screen, and check it there.** Build a
  coverage table: every test question → the screen that teaches it → the in-module check
  question that confirms it. A fact taught in a single line, with no check, counts as weak.
- **Check questions teach.** After any answer, show one line explaining why. A wrong answer says
  "Not quite… Try again", and the worker can't move on until the answer is right. Checks don't
  count toward the score.
- **Ask the check in different words from the test,** so the worker learns the idea instead of
  memorizing the test's answer.
- **Test answer options must all be plausible and distinct.** Drop near-duplicates (*"Two
  answers are very similar (Laying flat and fully reclined)"*). If the question is "which are
  risks", every option must be a risk (*"Only one option represents a risk"*). Display
  percentages as percentages, not `0.2`.
- **Don't imply a window that the guidance doesn't have.** "Start within 72 hours" became "Start
  as soon as possible, ideally right after birth". Wording that sounds like permission to wait
  is a teaching error.
- **The module, its checks, the test and the images must agree on every fact.** When sources
  disagree (2 kg vs 2.5 kg; 8 vs 20+ hours; 15–30° vs 40–45°), ask the reviewer, then change
  all of them together. Her call on the recline was 15–30°, matching the detailed diagram she
  kept.

## 6. Images: real and detailed where it's clinical, consistent where it's not

- **Keep real photographs.** *"I did like the photographs so please retain those."* Drop a photo
  that alarms more than it teaches (the incubator photo).
- **Clinical teaching images must show the technique in detail.** On the KC positioning
  diagram: *"we can see how the cloth of the wrap is positioned against the baby's body, and
  where it wraps around the mother … where the baby's leg is positioned … that the baby is
  against the mother's bare skin, which is the entire point of this program … that the neck is
  slightly extended."* If no new image matches that detail, **keep the original diagram** and
  crop out any text that contradicts the app (the "15–30° Protocol" box, "KMC" lettering).
  Danger signs got the same treatment.
- **Use generated illustrations only for less clinical scenes:** feeding, family support,
  hygiene, the health worker's visit. Then:
  - **One consistent style** across all of them. *"They are using different types of cartoons /
    colors / font"* was the first complaint.
  - **Black African families, including every baby,** for Nigeria, Uganda and Kenya. Check the
    baby's skin in every image: the generator repeatedly drew light-skinned babies.
  - **Plain, neutral backgrounds.** *"Lets get rid of the dirt floor. All backgrounds should be
    ambiguous."*
  - **The health worker dresses like the community,** not in clinical whites.
  - **Show the action correctly.** For breastfeeding, the baby faces the mother at chest level,
    not the camera, with no breast shown. For skin-to-skin, show bare chest, visibly. Make
    relationships readable: the father must not look as if he is sitting on the mother.
  - **No distracting details**, such as a pompom on the baby's hat. Remove them by hand-editing
    the image rather than regenerating it, which tends to break something else.
  - **No words in generated images.**
- **The image and the text must agree.** An image that contradicts the screen's text is a
  teaching error, not a style issue.
- **Every image fits a phone screen.** Labels inside a diagram must still be readable at phone
  width. Crop tighter or split it if they aren't.

## 7. Icons: quiet, uniform, literal

- **One style for every tile:** same line weight, one color, plain white background. Drop the
  changing colors. *"I want simpler icons … I want conformity across icons."*
- **Take the color from the app's own original palette** (KC: blue-purple `#7045DA`, the median
  of the original icons' blue-purples), so the set still looks like the same app.
- **Make each icon picture its module name literally:** a camera for the photo module, two
  simple adults with a speech bubble for Counseling Families, a house with a closed door and a
  check for Ending Home Visits, a mother holding a baby for the basics. Avoid anything that reads
  as a generic thumbnail.
- **Keep sensitive modules quiet.** *"A less loud icon for the KC Discontinuation Criteria"*: no
  red or purple X.
- Draw icons as SVG and render them in-house. They are simple enough that a generator only adds
  noise.

## 8. How she likes to work

These describe the collaboration, not the app. `demo-app-makeover` turns them into steps.

- **Show the planned changes first, then build everything before the next review.** Her first
  ask was a change list and questions to approve. Jonathan's follow-up set the cadence: *"build
  all this out before we look again and take clear screenshots and walkthroughs."* Make sensible
  default decisions, and list each one so it can be overturned.
- **She reviews on her phone and sends notes rapid-fire.** Take each note, apply it in the
  background, and reply with the build number to update to. Once she is testing hands-on, don't
  confirm every change with screenshots: *"no need to confirm with screenshots. I can poke around
  the app."*
- **Answer her direct question first,** then act.
- **Look at every image yourself before she sees it.** A sample sheet once reached her with a
  white baby that had been reported as checked.
- **When a tool can't reach her bar, say so and recommend the fallback** rather than iterating
  the tool further. The generator could not match the detailed clinical diagrams, and keeping
  the originals was the right call.
- **Remind her of anything she deferred** ("remind me later … once I actually test the app").
