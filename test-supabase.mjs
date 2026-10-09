import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testSupabase() {
  console.log("Testing Supabase connection...");
  
  // 1. Try to read
  const { data: readData, error: readError } = await supabase.from('employees').select('*').limit(1);
  if (readError) {
    console.log("READ ERROR:", readError.message, readError.details, readError.hint);
  } else {
    console.log("Read successful.");
  }

  // 2. Try to insert
  const { data: insertData, error: insertError } = await supabase.from('employees').insert({
    name: 'Test Setup User',
    designation: 'Tester'
  }).select();
  
  if (insertError) {
    console.log("INSERT ERROR:", insertError.message, insertError.details, insertError.hint);
  } else {
    console.log("Insert successful. Cleaning up...");
    if (insertData && insertData[0]) {
       await supabase.from('employees').delete().eq('id', insertData[0].id);
    }
  }
}

testSupabase();
