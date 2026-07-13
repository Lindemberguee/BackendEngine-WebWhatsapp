export interface TemplateVariable {
    name: string
    defaultValue?: string
    required?: boolean
}

export interface MessageTemplate {
    id: string
    name: string
    description?: string
    content: string
    variables: TemplateVariable[]
    category?: string
    createdAt: Date
    updatedAt: Date
}

export interface TemplateData {
    [key: string]: string | number | undefined
}

export declare class TemplateManager {
    private templates
    constructor()
    private generateId
    private extractVariables
    create(options: {
        name: string
        content: string
        description?: string
        category?: string
        id?: string
    }): MessageTemplate
    get(id: string): MessageTemplate | undefined
    getByName(name: string): MessageTemplate | undefined
    getAll(): MessageTemplate[]
    getByCategory(category: string): MessageTemplate[]
    update(id: string, updates: Partial<Omit<MessageTemplate, 'id' | 'createdAt'>>): MessageTemplate | undefined
    delete(id: string): boolean
    render(id: string, data?: TemplateData): string
    renderContent(content: string, data?: TemplateData): string
    validate(id: string, data: TemplateData): {
        valid: boolean
        missing: string[]
    }
    export(): string
    import(json: string, overwrite?: boolean): number
}

export declare const PRESET_TEMPLATES: Record<string, Omit<MessageTemplate, 'id' | 'createdAt' | 'updatedAt' | 'variables'>>

export declare const createTemplateManager: (includePresets?: boolean) => TemplateManager

export declare const renderTemplate: (content: string, data?: TemplateData) => string
