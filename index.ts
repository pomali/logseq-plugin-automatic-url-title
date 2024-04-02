import '@logseq/libs';
import { BlockEntity } from '@logseq/libs/dist/LSPlugin.user';

const DEFAULT_REGEX = {
    wrappedInCommand:
        /(\{\{\s*\w*\s*(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\s*\w*\s*\}\})/gi,
    command: /\{\{\s*(\w*)\s*/i,
    wrappedInCodeTags:
        /((`|```).*(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,}).*(`|```))/gi,
    line: /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\)\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\)\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\)\s]{2,}|www\.[a-zA-Z0-9]+\.[^\)\s]{2,})/gi,
    htmlTitleTag: /<title(\s[^>]+)*>([^<]*)<\/title>/,
    imageExtension: /\.(gif|jpe?g|tiff?|png|webp|bmp|tga|psd|ai)$/i,
};

const titleRegexps = [
    /<meta\sproperty="twitter:title"\scontent="([^"]*)/i,
    /<title\s?[^>]*>([^<]*)<\/title>/i,
];

const FORMAT_SETTINGS = {
    markdown: {
        formatBeginning: '](',
        applyFormat: (title: string, url: string) => `[${title}](${url})`,
    },
    org: {
        formatBeginning: '][',
        applyFormat: (title: string, url: string) => `[[${url}][${title}]]`,
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
    let content = '';
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
    const redditMatch = url.match(/reddit.com\/r\/[^/]+\/comments\/([^/]+)/);
    if (redditMatch && redditMatch.length) {
        const id = redditMatch[1];
        const api = `https://www.reddit.com/api/info.json?id=t3_${id}`;
        try {
            const response = await fetch(api);
            const data = await response.json();
            const post = data?.data?.children[0]?.data ?? {};
            if (post.title) {
                if (post.subreddit_name_prefixed)
                    return `${post.subreddit_name_prefixed} — ${post.title}`;
                return post.title;
            }
        } catch (e) {
            console.error(e);
        }
    }

    for (const titleRegexp of titleRegexps) {
        const matches = content.match(titleRegexp);
        if (matches && matches.length) return decodeHTML(matches[1].trim());
    }

    return '';
}

async function convertUrlToMarkdownLink(
    url: string,
    text: string,
    urlStartIndex: number,
    offset: number,
    applyFormat: (title: string, url: string) => string
) {
    const title = await getTitle(url);
    if (title === '') {
        return { text, offset };
    }

    const wrappedUrl = applyFormat(title, url);
    const startSection = text.slice(0, urlStartIndex);
    const endSection = text.slice(urlStartIndex + url.length);

    return {
        text: `${startSection}${wrappedUrl}${endSection}`,
        offset: urlStartIndex + url.length,
    };
}

async function convertUrlToChildBlock(
    url: string,
    rawBlock: BlockEntity,
    formatSettings: { formatBeginning?: string; applyFormat: any }
) {
    const title = await getTitle(url);
    if (title === '') {
        return;
    }

    const wrappedUrl = formatSettings.applyFormat(title, url);
    await logseq.Editor.insertBlock(rawBlock.uuid, wrappedUrl, {
        before: false,
        sibling: false,
        focus: true,
    });
}

function isImage(url) {
    const imageRegex = new RegExp(DEFAULT_REGEX.imageExtension);
    return imageRegex.test(url);
}

function isAlreadyFormatted(text, url, urlIndex, formatBeginning) {
    return text.slice(urlIndex - 2, urlIndex) === formatBeginning;
}

function isWrappedInCommand(text: string, url: string) {
    const wrappedLinks = text.match(DEFAULT_REGEX.wrappedInCommand);
    if (!wrappedLinks) {
        return false;
    }
    return wrappedLinks.some((command) => command.includes(url));
}

function isVideoCommand(text: string) {
    const command = text.match(DEFAULT_REGEX.command);
    return command && command[1] === 'video';
}

function isWrappedInCodeTags(text, url) {
    const wrappedLinks = text.match(DEFAULT_REGEX.wrappedInCodeTags);
    if (!wrappedLinks) {
        return false;
    }

    return wrappedLinks.some((command) => command.includes(url));
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
    const results = text.matchAll(DEFAULT_REGEX.line);
    if (!results) {
        return;
    }

    const formatSettings = await getFormatSettings();
    if (!formatSettings) {
        return;
    }

    let offset = 0;
    for (const result of results) {
        let url = result[0];
        const urlIndex = result.index;

        if (urlIndex === undefined) {
            continue;
        }

        if (
            isAlreadyFormatted(
                text,
                url,
                urlIndex,
                formatSettings.formatBeginning
            )
        ) {
            continue;
        }

        if (isImage(url)) {
            continue;
        }

        if (isWrappedInCodeTags(text, url)) {
            continue;
        }

        if (isWrappedInCommand(text, url)) {
            if (!isVideoCommand(text)) {
                continue;
            } else {
                // fix for video command and trailing `}}`
                if (url.endsWith('}}')) {
                    url = url.slice(0, -2);
                    if (
                        isAlreadyFormatted(
                            text,
                            url,
                            urlIndex,
                            formatSettings.formatBeginning
                        )
                    ) {
                        continue;
                    }
                }
                const childBlockUuid = rawBlock?.children?.[0]?.[1];
                if (!childBlockUuid) {
                    convertUrlToChildBlock(url, rawBlock, formatSettings);
                    continue;
                }

                const childBlock = await logseq.Editor.getBlock(
                    childBlockUuid[0]
                );
                if (!childBlock || !childBlock.content.match(url)) {
                    convertUrlToChildBlock(url, rawBlock, formatSettings);
                }

                continue;
            }
        }

        const updatedTitle = await convertUrlToMarkdownLink(
            url,
            text,
            urlIndex,
            offset,
            formatSettings.applyFormat
        );
        text = updatedTitle.text;
        offset = updatedTitle.offset;
    }

    await logseq.Editor.updateBlock(rawBlock.uuid, text);
}

const main = async () => {
    try {
        logseq.App.registerCommandPalette(
            { key: 'format-url-titles', label: 'Format url titles' },
            async (e) => {
                const selected =
                    (await logseq.Editor.getSelectedBlocks()) ?? [];
                selected.forEach((block) => parseBlockForLink(block.uuid));
            }
        );
    } catch (e) {
        console.log('Error registering command palette');
        console.error(e);
    }

    logseq.DB.onChanged(async (e) => {
        if (e.txMeta?.outlinerOp === 'insert-blocks') {
            for (const block of e.blocks ?? []) {
                if (!block.name) {
                    if (!block.content) {
                        // is not a page
                        if (block.left) {
                            // is new block
                            parseBlockForLink(block.left.id);
                        }
                    }
                }
            }
        }
    });
};

logseq.ready(main).catch(console.error);
