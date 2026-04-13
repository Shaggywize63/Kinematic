
import { supabaseAdmin } from "./src/lib/supabase";

async function diagnoseLoss() {
  const formId = "9a3b54e0-778c-4064-aa87-d05429c81631";
  
  // 1. Check questions for this form
  const { data: qs, error: e1 } = await supabaseAdmin
    .from("builder_questions")
    .select("*")
    .eq("form_id", formId);
    
  console.log(`Questions found for form ${formId}:`, qs?.length || 0);
  if (qs && qs.length > 0) {
    console.log("Samples:", qs.slice(0, 3).map(q => ({ id: q.id, label: q.label, form_id: q.form_id })));
  }

  // 2. Check ALL questions to see if they were orphaned
  const { data: allQs, error: e2 } = await supabaseAdmin
    .from("builder_questions")
    .select("count", { count: 'exact' });
  
  console.log("Total questions in builder_questions table:", allQs);

  // 3. Check for deleted forms or logs if possible (likely not)
}

diagnoseLoss();
