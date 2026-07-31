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
  source: string | null;
  createdAt: string;
}

export function useContacts(params?: { search?: string; page?: number }) {
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["crm"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
