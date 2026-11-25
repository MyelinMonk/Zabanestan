# Zabanestan learning tools

The learning tools from [Zabanestan](https://zabanestan.org), a volunteer community that documents, preserves and teaches endangered and vulnerable Iranic languages.

- **[Khānesh](khanesh/)** is a reader and flashcard app for learning languages from real texts, recordings and YouTube videos. You read, tap the words you don’t know, and review them as flashcards scheduled with FSRS. It imports and exports Anki decks, and with an account it keeps your words on every device. [Try it](https://zabanestan.org/khanesh/) or read [the guide](https://zabanestan.org/reader.html).
- **[The OCR helper script](khanesh/tools/khanesh_tools.py)** turns scanned books into text with [kraken](https://kraken.re), and helps you train a model on your own book. [The guide](https://zabanestan.org/reading-model.html) walks you through it.
- **[The Wikipedia reading finder](wikipedia-finder/)** finds the Wikipedia articles most worth reading in Mazandarani, Gilaki, Taleshi, Ossetian and Zazaki. [Try it](https://zabanestan.org/wikipedia-reading.html).

## License

The code is free to use, change and share for noncommercial purposes, such as study, teaching, research and personal projects, under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Schools, universities, public research organizations and charities may use it for any purpose. If you share the code or something built from it, keep the license and the line that begins `Required Notice:`, so Zabanestan is credited.

Third-party libraries and fonts keep their own licenses, listed in `khanesh/build.py` and in the built app’s `THIRD-PARTY.txt`.

For commercial use, or any questions, write to support@zabanestan.org. Bug reports and ideas are welcome as issues here.
