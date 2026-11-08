---
layout: about
title: Reader
description: "Khwānish, Zabanestan’s free reader: read texts in our languages, tap the words you don’t know, and review them as flashcards."
lead: "Khwānish (<span class=\"ar\" lang=\"fa\" dir=\"rtl\">خوانش</span>, “reading”) is our free reader for learning by reading. Open a text in any of our languages, tap the words you don’t know, and review them as flashcards. It runs in your browser, and you don’t need an account."
actions:
  - label: "Open the reader"
    url: khwanish/
---
{%- comment -%}
The reader itself is the folder khwanish/: a single page with its fonts and libraries beside it.
Its source code and build script are in _khwanish/ (folders starting with _ aren't published).
Every heading has an id after it, {#like-this}: the reader links to #ocr, and the list of
sections at the side is built from these ids.
{%- endcomment %}

## What it does {#what-it-does}

- **Read with help.** Words you haven’t met yet are shaded blue. Tap one to write its meaning, open a dictionary, or save it.
- **Flashcards that come back at the right time.** Each word you save becomes two flashcards: word to meaning, and meaning to word. Reviews are spaced with FSRS, the method Anki uses, so each card returns just before you would forget it.
- **Progress you can see.** Words you’re learning are shaded gold, and the shade fades as you learn them.
- **Anki when you want it.** Send your cards to Anki with their schedules and review history.
{% if site.reader_accounts %}- **Private, and shareable if you want.** Your reading and flashcards stay in your browser. If you like, sign in to share texts, word lists and OCR models.
{% else %}- **Private.** There’s no account and no server. Your texts and words stay in your browser.
{% endif %}

## Start reading {#start}

1. [Open the reader](khwanish/). On a phone, add it to your home screen so it opens like an app.
2. Choose your language from the menu at the top. Persian and every language on [our roster](languages.html) are ready to use. To add another, or to set up your own, tap **Add a language**.
3. In the **Library**, import a text. It can be a text file (.txt or .md), a web page (.html), subtitles (.srt or .vtt) or a PDF that has text inside it. You can also paste a text, or start with the sample.
4. Tap a word you don’t know. Write its meaning, using the dictionary links in the panel if you like, then tap **Add flashcards**.
5. Turn the page when you’re done. Blue words you didn’t tap count as known. You can undo that, or switch it off in **Options**.
6. Open **Review** once a day. Show the answer, then grade yourself: Again, Hard, Good or Easy.

Import only texts you have the right to use. What you import stays in your browser and isn’t shared with anyone.

## Your words stay in your browser {#saving}

{% if site.reader_accounts %}Everything you read and save lives in the browser you use the reader in, on that device. Signing in doesn’t change that: an account holds only what you choose to share. Keeping things on your device keeps them private, but it also means:{% else %}The reader has no server, so everything you save lives in the browser you use it in, on that device. That keeps it private, but it also means:{% endif %}

- **Back up now and then.** In **Options**, tap **Back up everything** to save a file with all your texts and words. The reader reminds you when it’s been a while.
- **Moving to another device?** Open the reader there, go to **Options** and choose **Restore from a backup file**. Recordings aren’t in backups, so choose those files again after you restore.
- **Browsers can clear saved data.** Safari, for example, can delete a site’s data if you haven’t visited it for a while. Adding the reader to your home screen helps, and a recent backup means nothing is lost.
- **Private windows forget everything** when you close them.

{% if site.reader_accounts %}
## Sharing with other learners {#sharing}

An account is optional. With one, you can keep texts, word lists and OCR models online and choose who can open each one:

- **Only me**: private, for your own use on any device.
- **Anyone with the link**: unlisted. It isn’t listed anywhere, but anyone you send the link to can open it.
- **Everyone**: public. It opens by link straight away, and joins the **Shared library** once someone on our team has checked it.

To start, open **Options › Account** and sign in with Google. Then use **Share** in a text’s menu in the Library, **Share a word list** in Words, or **Share an OCR model** on your account page. To share something publicly, say where it comes from, choose a license, and confirm that it’s yours to share. We check that before listing it, and take down anything that isn’t.

**What we keep.** Your Google email address, which only you and our admins can see; a display name, but only if you choose one, so otherwise you appear as “A Zabanestan member”; and what you share. Your reading and flashcards are never uploaded. You can delete your account, and everything in it, from your account page.

{% endif %}
## Flashcards and Anki {#anki}

New cards arrive 20 a day. In **Options** you can change that, and choose how reliably you want to remember each card: higher means more reviews.

To move your cards into [Anki](https://apps.ankiweb.net):

1. Open **Words** and tap **Export to Anki**.
2. Keep **Anki package** selected. It carries each card’s schedule and review history. A text file has only the words and meanings, and its cards start as new.
3. Tap **Save file**, then open the .apkg file in Anki: **File › Import** on a computer, or open it in AnkiMobile or AnkiDroid.
4. Leave **Import any learning progress** ticked. To keep the same scheduling, turn on FSRS in Anki’s deck options.

**Only words I haven’t exported before** is ticked at first, so you can export again later without making duplicates.

## Scanned books {#ocr}

The reader opens PDFs that have text inside them. A scanned book is only pictures of pages, so it has to be turned into text first. That step is called OCR.

Our helper script does it on your own computer with [kraken](https://kraken.re), free OCR software with models for Arabic-script languages. kraken runs on Linux and macOS; on Windows, use it through WSL.

You don’t have to train a model yourself. A trained model is a single file, so once one person trains a model for a script or a printing style, everyone can use it. {% if site.reader_accounts %}Look for one under OCR models in the reader’s **Shared library**, and share yours there too.{% else %}If someone in the community has trained one for your language, they can send you the file.{% endif %}

1. Install [Python 3](https://www.python.org/downloads/), then kraken:

   ```
   pip install kraken pymupdf
   ```

2. <a href="khwanish/tools/khwanish_tools.py" download>Download the helper script</a>, khwanish_tools.py.
3. Find a recognition model for your script, and download it with the ID in the first column of the list:

   ```
   python khwanish_tools.py models
   kraken get MODEL_ID
   ```

4. Turn the PDF into text. `-p` chooses pages:

   ```
   python khwanish_tools.py ocr book.pdf --model MODEL_FILE -p 1-20
   ```

   This saves book.txt next to the PDF. Import it into the reader.

### Teach the model your text {#train}

If the model misreads letters, for example ones Persian doesn’t use, such as Sorani’s ڕ and ۆ, you can teach it with a few pages of your own:

1. Cut the pages into lines. This also makes a correction page, training/correct.html:

   ```
   python khwanish_tools.py prepare book.pdf -p 1-10 --model MODEL_FILE
   ```

2. Open correct.html in your browser and fix the text under each line. Tick **Leave this line out** for bad cuts. Then tap **Save corrections** and move corrections.json into the training folder.
3. Fine-tune the model on your lines. A few hundred corrected lines give good results, and a computer with a graphics card is much faster:

   ```
   python khwanish_tools.py train training --base MODEL_FILE --name my-model
   ```

4. Use the new model, saved in the my-model folder, with `ocr` as above.

OCR only books you’re allowed to copy, and don’t share scans or text of copyrighted books.

## Recordings and recitations {#recordings}

The reader can play an audio or video file beside its text, highlighting each line as it’s spoken. Tap a line to jump to it, repeat it, or slow it down.

In the **Library**, tap **Audio or video**, then choose the recording and its timing file: subtitles (.srt or .vtt), lyrics (.lrc) or a file from the helper script. Recordings stay on your device.

The helper script can fetch both for you:

- **YouTube videos**, with subtitles in the video’s own language. It uses subtitles written by the uploader when there are any, and YouTube’s automatic captions otherwise. Add `--audio-only` for a smaller file. It needs `pip install yt-dlp`.

  ```
  python khwanish_tools.py youtube VIDEO_URL --lang fa
  ```

- **[Ganjoor](https://ganjoor.net) poems** with a recitation, timed verse by verse. Add `--list` to see a poem’s recitations and `-r 2` to choose another. It needs `pip install requests`.

  ```
  python khwanish_tools.py ganjoor https://ganjoor.net/hafez/ghazal/sh1
  ```

Download only what you’re allowed to keep: your own recordings, openly licensed ones, or ones whose owner allows it.

## Languages and dictionaries {#languages}

The reader handles text written right to left or left to right, in Arabic, Cyrillic, Latin and Devanagari script. For each language it knows which spellings to treat as the same word, such as ي and ی, or ك and ک, and it can ignore optional vowel marks and stress accents.

- **Our roster** and Persian are ready to use. **Add a language** offers more Iranian and Indo-Aryan languages, as well as Tajik, Pali, Sanskrit and French.
- **Your own language.** Set its name, code, writing direction and the letters to treat as the same.
- **Dictionaries.** The word panel links to dictionaries for each language: Vajehyab, Abadis and Steingass for Persian, and Wiktionary and Glosbe for many of our languages.

## Questions and source code {#about-the-reader}

Found a problem, or have an idea? [Contact us](contact.html), or tell us on [Discord]({{ site.discord_invite }}).

Like all our software, the reader is open source under the [MIT License](khwanish/LICENSE.txt). Its fonts and libraries have [their own open licenses](khwanish/THIRD-PARTY.txt).
