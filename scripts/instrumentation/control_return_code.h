#include <stddef.h>
#include <string.h>

// Copy the already escaped wire value, never decode it into notification syntax.
// Absent correlation is valid; duplicate, oversized and unsafe values fail closed.
static int copy_return_code(const char *raw,size_t length,char *out,size_t capacity) {
  if(!raw || !out || !capacity || length>2048)return 0;
  out[0]=0;int found=0;
  for(size_t start=0;start<length;) {
    while(start<length && raw[start]==' ')start++;
    size_t end=start;
    while(end<length && raw[end]!=' ') {
      unsigned char c=(unsigned char)raw[end];
      if(c<33 || c>126 || c=='|')return 0;
      end++;
    }
    if(end-start>=12 && !memcmp(raw+start,"return_code=",12)) {
      size_t n=end-start-12;
      if(found++ || !n || n>=capacity)return 0;
      memcpy(out,raw+start+12,n);out[n]=0;
    }
    start=end;
  }
  return 1;
}
