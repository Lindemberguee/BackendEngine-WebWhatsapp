export interface VCardContact {
    /** Full name */
    fullName: string
    /** Display name (optional) */
    displayName?: string
    /** Organization/Company */
    organization?: string
    /** Title/Position */
    title?: string
    /** Phone numbers */
    phones?: Array<{
        number: string
        type?: 'CELL' | 'WORK' | 'HOME' | 'MAIN' | 'FAX' | 'PAGER'
        label?: string
    }>
    /** Email addresses */
    emails?: Array<{
        email: string
        type?: 'WORK' | 'HOME' | 'OTHER'
    }>
    /** Website URLs */
    urls?: Array<{
        url: string
        type?: 'WORK' | 'HOME' | 'OTHER'
    }>
    /** Physical addresses */
    addresses?: Array<{
        street?: string
        city?: string
        state?: string
        postalCode?: string
        country?: string
        type?: 'WORK' | 'HOME' | 'OTHER'
    }>
    /** Birthday (YYYY-MM-DD format) */
    birthday?: string
    /** Notes */
    note?: string
}

/** Generate vCard string from contact data */
export declare const generateVCard: (contact: VCardContact) => string

/** Generate multiple vCards (for contact array) */
export declare const generateVCards: (contacts: VCardContact[]) => string

/** Parse vCard string to contact data (basic parser) */
export declare const parseVCard: (vcard: string) => Partial<VCardContact>

/** Create a simple contact card message content */
export declare const createContactCard: (contact: VCardContact) => {
    contacts: {
        displayName: string
        contacts: Array<{ vcard: string }>
    }
}

/** Create an array of contact cards message content */
export declare const createContactCards: (contacts: VCardContact[]) => {
    contacts: {
        displayName: string
        contacts: Array<{ vcard: string }>
    }
}

/** Quick helper to create contact from phone number */
export declare const quickContact: (
    name: string,
    phone: string,
    options?: { organization?: string; email?: string }
) => VCardContact
