/** Preserve every cent sent through the existing numeric product API contract. */
export function savingsMinimum(value:string):number {
 const text=value.trim();
 if(text.length>24||!/^\d+(?:\.\d{1,2})?$/.test(text))throw new Error('Enter a non-negative minimum with up to two decimal places.');
 const cents=(s:string)=>{const[w,f='']=s.split('.');return BigInt(w!)*100n+BigInt(f.padEnd(2,'0'));};
 const original=cents(text),number=Number(text),serialized=String(number);
 if(original>9_999_999_999_999_999_999n||!/^\d+(?:\.\d{1,2})?$/.test(serialized)||cents(serialized)!==original)throw new Error('This minimum cannot be sent exactly through the current product form. No change was sent.');
 return number;
}
