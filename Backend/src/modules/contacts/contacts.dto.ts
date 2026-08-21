import { z } from 'zod';
import type { ContactStatus, ContactSource } from '../../db/models';

export const CreateContactSchema = z.object({
  phone: z.string().min(1).regex(/^\d+$/),
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  company: z.string().max(100).optional(),
  position: z.string().max(100).optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(1000).default(''),
  source: z.enum(['manual', 'whatsapp', 'import', 'api']).default('manual'),
  marketingOptIn: z.boolean().default(false),
  marketingOptInSource: z.string().min(1).max(100).optional(),
  marketingOptInProof: z.string().max(500).optional(),
});

export const UpdateContactSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  company: z.string().max(100).optional(),
  position: z.string().max(100).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  status: z.enum(['active', 'blocked', 'archived']).optional(),
  marketingOptIn: z.boolean().optional(),
  marketingOptInSource: z.string().min(1).max(100).optional(),
  marketingOptInProof: z.string().max(500).optional(),
});

export const BulkTagSchema = z.object({
  contactIds: z.array(z.string()).min(1),
  tag: z.string().min(1),
  action: z.enum(['add', 'remove']),
});

export const BulkStatusSchema = z.object({
  contactIds: z.array(z.string()).min(1),
  status: z.enum(['active', 'blocked', 'archived']),
});

// Same shape as CreateContactSchema but without a `source` default override —
// the import route always forces source:'import' server-side regardless of
// what the client sends, so it isn't part of this schema.
export const ImportContactSchema = z.object({
  phone: z.string().min(1).regex(/^\d+$/),
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(1000).default(''),
});

export const ImportContactsSchema = z.object({
  contacts: z.array(ImportContactSchema).min(1).max(2000),
  marketingOptIn: z.boolean().default(false),
  marketingOptInSource: z.string().min(1).max(100).optional(),
  marketingOptInProof: z.string().max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.marketingOptIn && !value.marketingOptInSource?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['marketingOptInSource'],
      message: 'Informe a origem do consentimento de marketing',
    });
  }
});

export const ListContactsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(['active', 'blocked', 'archived']).optional(),
  tag: z.string().optional(),
  sortBy: z.enum(['name', 'lastSeen', 'createdAt']).default('lastSeen'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export interface ContactResponse {
  id: string;
  phone: string;
  name: string;
  email?: string;
  company?: string;
  position?: string;
  avatarUrl?: string;
  tags: string[];
  status: ContactStatus;
  source: ContactSource;
  notes?: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
  conversationCount: number;
  whatsappOptInAt?: string;
  whatsappOptInSource?: string;
  whatsappOptInProof?: string;
}

export interface ContactDetailResponse extends ContactResponse {
  pushName?: string;
  jid: string;
  customFields?: Record<string, unknown>;
  recentMessages?: Array<{
    id: string;
    content: string;
    direction: 'inbound' | 'outbound';
    timestamp: string;
  }>;
}

export interface ListContactsResponse {
  data: ContactResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export type CreateContactInput = z.infer<typeof CreateContactSchema>;
export type UpdateContactInput = z.infer<typeof UpdateContactSchema>;
export type ListContactsQuery = z.infer<typeof ListContactsQuerySchema>;
export type BulkTagInput = z.infer<typeof BulkTagSchema>;
export type BulkStatusInput = z.infer<typeof BulkStatusSchema>;
export type ImportContactInput = z.infer<typeof ImportContactSchema>;
export type ImportContactsInput = z.infer<typeof ImportContactsSchema>;
