import type { SupabaseClient } from '@supabase/supabase-js';
import type { Department, Position } from '@/types/domain';

export async function listDepartments(supabase: SupabaseClient): Promise<Department[]> {
  const { data, error } = await supabase
    .from('departments')
    .select('*')
    .eq('active', true)
    .order('code');
  if (error) throw error;
  return (data ?? []) as Department[];
}

export async function listPositions(supabase: SupabaseClient): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('active', true)
    .order('grade_level', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as Position[];
}
