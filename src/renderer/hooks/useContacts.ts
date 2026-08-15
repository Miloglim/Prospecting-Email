import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface Contact {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  companyId: number | null;
  companyName: string | null;
  country: string | null;
  clientType: string | null;
  stage: string | null;
  status: string | null;
  tags: string | null;
  extra: string | null;
  assignee: string | null;
  source: string | null;
  sourceDetail: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ContactFilters {
  stage?: string; status?: string; tags?: string; clientType?: string; country?: string;
}

export function useContacts(params?: { search?: string; page?: number } & ContactFilters) {
  return useQuery({
    queryKey: ["contacts", params],
    queryFn: () => window.api.invoke("contacts:list", params) as Promise<{
      success: boolean;
      data?: { items: Contact[]; total: number };
      error?: string;
    }>,
  });
}

export function useContact(id: number) {
  return useQuery({
    queryKey: ["contacts", id],
    queryFn: () => window.api.invoke("contacts:getById", id) as Promise<{
      success: boolean;
      data?: Contact;
      error?: string;
    }>,
    enabled: id > 0,
  });
}

export function useUpsertContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      window.api.invoke("contacts:upsert", input) as Promise<{
        success: boolean;
        data?: Contact;
        error?: string;
      }>,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["contacts"] }); },
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      window.api.invoke("contacts:delete", id) as Promise<{
        success: boolean;
        error?: string;
      }>,
    // ponytail: 乐观删除 — 点击立即从列表消失，失败回滚（消除 IPC+写盘+重拉的延迟感）
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["contacts"] });
      const snapshot = qc.getQueriesData({ queryKey: ["contacts"] });
      qc.setQueriesData<{ success: boolean; data: { items: Contact[]; total: number } }>(
        { queryKey: ["contacts"] },
        (old) => old?.success && old.data
          ? { ...old, data: { ...old.data, items: old.data.items.filter(c => c.id !== id), total: old.data.total - 1 } }
          : old,
      );
      return { snapshot };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.snapshot) {
        for (const [key, data] of ctx.snapshot) qc.setQueryData(key, data);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["crm"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
