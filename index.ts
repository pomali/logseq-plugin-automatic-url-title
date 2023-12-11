import '@logseq/libs';

const DEFAULT_REGEX = {
    wrappedInCommand: /(\{\{\s*\w*\s*(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\s*\w*\s*\}\})/gi,
    wrappedInCodeTags: /((`|```).*(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,}).*(`|```))/gi,
    line: /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\)\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\)\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\)\s]{2,}|www\.[a-zA-Z0-9]+\.[^\)\s]{2,})/gi,
    imageExtension: /\.(gif|jpe?g|tiff?|png|webp|bmp|tga|psd|ai)$/i,
};

const titleRegexps = [
    /<meta\sproperty="twitter:title"\scontent="([^"]*)/i,
    /<title\s?[^>]*>([^<]*)<\/title>/i,
]

const FORMAT_SETTINGS = {
    markdown: {
        formatBeginning: '](',
        applyFormat: (title, url) => `[${title}](${url})`,
    },
    org: {
        formatBeginning: '][',
        applyFormat: (title, url) => `[[${url}][${title}]]`,
    },
};

function decodeHTML(input) {
    if (!input) {
        return '';
    }

    const doc = new DOMParser().parseFromString(input, 'text/html');
    return doc.documentElement.textContent;
}

async function getTitle(url) {
    let content = ''
    try {
        const response = await fetch(url);
        content = await response.text();
    } catch (e) {
        console.error(e);
    }

    /**
     * Special case for reddit.com
     *
     * url: https://www.reddit.com/r/logseq/comments/13yeg3i/noob_question_how_to_approach_daily_journal_notes/
     * api: https://www.reddit.com//api/info.json?id=t3_13yeg3i
     */
    const redditMatch = url.match(/reddit.com\/r\/[^/]+\/comments\/([^/]+)/)
    if (redditMatch && redditMatch.length) {
        const id = redditMatch[1];
        const api = `https://www.reddit.com/api/info.json?id=t3_${id}`
        try {
            const response = await fetch(api);
            const data = await response.json();
            const post = data?.data?.children[0]?.data ?? {};
            if (post.title) {
                if (post.subreddit_name_prefixed)
                    return `${post.subreddit_name_prefixed} — ${post.title}`
                return post.title
            }
        } catch (e) {
            console.error(e);
        }
    }

    for (const titleRegexp of titleRegexps) {
        const matches = content.match(titleRegexp);
        if (matches && matches.length)
            return decodeHTML(matches[1].trim());
    }

    return '';
}

async function convertUrlToMarkdownLink(url, text, urlStartIndex, offset, applyFormat) {
    const title = await getTitle(url);
    if (title === '') {
        return { text, offset };
    }

    const startSection = text.slice(0, urlStartIndex);
    const wrappedUrl = applyFormat(title, url);
    const endSection = text.slice(urlStartIndex + url.length);

    return {
        text: `${startSection}${wrappedUrl}${endSection}`,
        offset: urlStartIndex + url.length,
    };
}

function isImage(url) {
    const imageRegex = new RegExp(DEFAULT_REGEX.imageExtension);
    return imageRegex.test(url);
}

function isAlreadyFormatted(text, url, urlIndex, formatBeginning) {
    return text.slice(urlIndex - 2, urlIndex) === formatBeginning;
}

function isWrappedInCommand(text, url) {
    const wrappedLinks = text.match(DEFAULT_REGEX.wrappedInCommand);
    if (!wrappedLinks) {
        return false;
    }

    return wrappedLinks.some(command => command.includes(url));
}

function isWrappedInCodeTags(text, url) {
    const wrappedLinks = text.match(DEFAULT_REGEX.wrappedInCodeTags);
    if (!wrappedLinks) {
        return false;
    }

    return wrappedLinks.some(command => command.includes(url));
}

async function getFormatSettings() {
    const { preferredFormat } = await logseq.App.getUserConfigs();
    if (!preferredFormat) {
        return null;
    }

    return FORMAT_SETTINGS[preferredFormat];
}

async function parseBlockForLink(uuid) {
    if (!uuid) {
        return;
    }

    const rawBlock = await logseq.Editor.getBlock(uuid);
    if (!rawBlock) {
        return;
    }

    let text = rawBlock.content;
    const urls = text.match(DEFAULT_REGEX.line);
    if (!urls) {
        return;
    }

    const formatSettings = await getFormatSettings();
    if (!formatSettings) {
        return;
    }

    let offset = 0;
    for (const url of urls) {
        const urlIndex = text.indexOf(url, offset);

        if (isAlreadyFormatted(text, url, urlIndex, formatSettings.formatBeginning) || isImage(url) || isWrappedInCommand(text, url) || isWrappedInCodeTags(text, url)) {
            continue;
        }

        const updatedTitle = await convertUrlToMarkdownLink(url, text, urlIndex, offset, formatSettings.applyFormat);
        text = updatedTitle.text;
        offset = updatedTitle.offset;
    }

    await logseq.Editor.updateBlock(rawBlock.uuid, text);
}

const main = async () => {
    logseq.App.registerCommandPalette(
        { key: 'format-url-titles', label: 'Format url titles' }, async (e) => {
            const selected = (await logseq.Editor.getSelectedBlocks()) ?? [];
            selected.forEach((block) => parseBlockForLink(block.uuid));
    });

    logseq.DB.onChanged(async (e) => {
        if (e.txMeta?.outlinerOp === 'insertBlocks') {
            for (const block of e.blocks ?? [])
                if (!block.name)  // is not a page
                    if (!block.content)  // is new block
                        if (block.left)
                            parseBlockForLink(block.left.id)
        }
    });
};

logseq.ready(main).catch(console.error);
