# Wikipedia reading finder

Finds the Wikipedia articles most worth reading for learners of Mazandarani, Gilaki, Taleshi, Ossetian and Zazaki. It takes the longest articles on that language’s Wikipedia, reads each one, and ranks them by how much of it is real prose, with more paragraphs and fewer tables and lists. It runs entirely in the browser, with requests going straight to Wikipedia.

It’s one script, `wikipedia-finder.js`, that fills in an element with the id `finder`. Open `index.html` to try it, or use it on [Zabanestan’s site](https://zabanestan.org/wikipedia-reading.html).

To add a language, add its Wikipedia to the `WIKIS` list at the top of the script.

Wikipedia limits how often you can ask it for pages. If you run the finder many times in an hour, it may stop for a few minutes.
