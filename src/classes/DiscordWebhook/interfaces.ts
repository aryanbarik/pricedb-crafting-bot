interface Author {
    name: string;
    url?: string;
    icon_url?: string;
}

interface Fields {
    name: string;
    value: string;
    inline?: boolean;
}

interface Footer {
    text: string;
    icon_url?: string;
}

interface Thumbnail {
    url: string;
}

interface Image {
    url: string;
}

interface Embeds {
    color?: string;
    author?: Author;
    title?: string;
    url?: string;
    description?: string;
    fields?: Fields[];
    thumbnail?: Thumbnail;
    image?: Image;
    footer?: Footer;
}

/**
 * Components V2 (message flag `IS_COMPONENTS_V2` = 32768). A message built from
 * these carries no `content`/`embeds` — see `Webhook` below. Only the shapes
 * the trade summary actually sends are modelled; Discord's full reference
 * includes buttons and selects, which a non-application webhook cannot send.
 */
export interface TextDisplay {
    type: 10;
    content: string;
}

export interface MediaGalleryItem {
    media: { url: string };
}

export interface MediaGallery {
    type: 12;
    items: MediaGalleryItem[];
}

export interface Separator {
    type: 14;
    /** Draws a visible rule. `false` is whitespace only — no line. */
    divider?: boolean;
    /** `1` (small) or `2` (large) gap. */
    spacing?: 1 | 2;
}

export interface Container {
    type: 17;
    accent_color?: number;
    components: (TextDisplay | MediaGallery | Separator)[];
}

export type Component = TextDisplay | MediaGallery | Separator | Container;

export interface Webhook {
    username?: string;
    avatar_url?: string;
    content?: string;
    embeds?: Embeds[];
    /** Components V2 only. Mutually exclusive with `content`/`embeds`. */
    components?: Component[];
    /** Must be `1 << 15` to send `components`. */
    flags?: number;
    allowed_mentions?: {
        parse?: ('users' | 'roles' | 'everyone')[];
        /** Explicit user IDs that may be mentioned when `parse` is empty. */
        users?: string[];
    };
}
