import { z } from 'zod';
import type { ContactStatus, ContactSource } from '../../db/models';

export const CreateContactSchema = z.object({
  phone: z.string().min(1).regex(/^\d+$/),
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(1000).default(''),
  source: z.enum(['manual', 'whatsapp', 'import', 'api']).default('manual'),
});

export const UpdateContactSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  status: z.enum(['active', 'blocked', 'archived']).optional(),
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
  avatarUrl?: string;
  tags: string[];
  status: ContactStatus;
  source: ContactSource;
  notes?: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
  conversationCount: number;
}

export interface ContactDetailResponse extends ContactResponse {
  pushName?: string;
  jid: string;
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
