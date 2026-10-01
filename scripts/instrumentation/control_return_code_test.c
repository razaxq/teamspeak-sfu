#include <assert.h>
#include "control_return_code.h"

int main(void) {
  char out[257];
  const char *plain="requestsfuaccessinfo return_code=5:17";
  assert(copy_return_code(plain,strlen(plain),out,sizeof(out)));
  assert(!strcmp(out,"5:17"));
  const char *escaped="requestsfuaccessinfo return_code=a\\sb\\p";
  assert(copy_return_code(escaped,strlen(escaped),out,sizeof(out)));
  assert(!strcmp(out,"a\\sb\\p"));
  assert(copy_return_code("requestsfuaccessinfo",20,out,sizeof(out)) && !out[0]);
  const char *bad[]={"requestsfuaccessinfo return_code=", "return_code=a return_code=b",
    "return_code=a\nnotify", "return_code=a|notify", "return_code=a\rnotify"};
  for(size_t i=0;i<sizeof(bad)/sizeof(bad[0]);i++)
    assert(!copy_return_code(bad[i],strlen(bad[i]),out,sizeof(out)));
  assert(!copy_return_code(plain,strlen(plain),out,3));
  assert(!copy_return_code("return_code=a\0x",15,out,sizeof(out)));
  return 0;
}
