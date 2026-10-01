#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <link.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include "control_return_code.h"

// Version-pinned experiment, never a production plugin. Access-info requires
// an explicitly configured private issuer. STREAM_SFU is opt-in publisher preview.
static uintptr_t base;
static int pinned;
static int log_fd=-1;
struct span { const char *data; size_t size; };
static void *(*original_lookup)(void *,const struct span *);
static _Thread_local unsigned char entry[64] __attribute__((aligned(16)));
static void event(const char *s) { if(log_fd>=0) { ssize_t n=write(log_fd,s,strlen(s)); (void)n; } }
static int locate(struct dl_phdr_info *info,size_t size,void *data) {
  (void)size;(void)data;
  if(info->dlpi_name && info->dlpi_name[0])return 0;
  base=info->dlpi_addr;
  const unsigned char id[20]={0x9c,0x35,0x94,0x4a,0xf5,0x09,0x57,0xba,0xba,0x66,0x9c,0xcf,0xeb,0xd4,0x0d,0x37,0xc0,0x2c,0x3b,0x43};
  for(int i=0;i<info->dlpi_phnum;i++) {
    const ElfW(Phdr) *p=&info->dlpi_phdr[i];
    if(p->p_type!=PT_NOTE)continue;
    const unsigned char *cur=(void *)(base+p->p_vaddr),*end=cur+p->p_memsz;
    while(cur+12<=end) {
      const ElfW(Nhdr) *n=(void *)cur;
      size_t names=(n->n_namesz+3U)&~3U,desc=(n->n_descsz+3U)&~3U;
      if(names>(size_t)(end-cur-12)||desc>(size_t)(end-cur-12-names))break;
      if(n->n_type==3 && n->n_namesz==4 && n->n_descsz==20 && !memcmp(cur+12,"GNU",4)
          && !memcmp(cur+12+names,id,20))pinned=1;
      cur+=12+names+desc;
    }
  }
  return 1;
}
static int ping(void *engine,void *command,void *packet,void *context,void *actor,void *flags) {
  (void)engine;(void)command;(void)packet;(void)context;(void)actor;(void)flags;
  event("{\"event\":\"sfulabping-handler-called\"}\n");
  return 0;
}
static int send_notification(void *packet,void *context,void *actor,const char *message) {
  if(!actor || !*(void **)actor || !packet || !context)return 256;
  unsigned client=((unsigned (*)(void *))(base+0xf098bc))(packet);
  unsigned meta=((unsigned (*)(void *))(base+0xf098ec))(packet);
  if(!client)return 256;
  unsigned char text[24]={0};
  size_t length=strlen(message);
  if(length<=22) { text[0]=length*2;memcpy(text+1,message,length+1); }
  else {
    // Observed libc++ long-string ABI: capacity|1, size, data. Packet ctor
    // copies the string; this borrowed view is not passed to a destructor.
    size_t capacity=(length+2)|1;
    memcpy(text,&capacity,8);memcpy(text+8,&length,8);memcpy(text+16,&message,8);
  }
  void *out=((void *(*)(size_t))(base+0x17ed054))(0xb0);
  ((void (*)(void *,void *,unsigned))(base+0xf1142c))(out,text,client);
  ((void (*)(void *,unsigned))(base+0xf0ecec))(out,meta);
  void *result[2]={0};
  ((void (*)(void *,void *,void *,void *))(base+0xba55e8))(*(void **)actor,context,out,result);
  if(result[1]) {
    long previous=__atomic_fetch_sub((long *)((char *)result[1]+8),1,__ATOMIC_ACQ_REL);
    if(previous==0) {
      void **vtable=*(void ***)result[1];
      ((void (*)(void *))vtable[2])(result[1]);
      ((void (*)(void *))(base+0x178d0dc))(result[1]);
    }
  }
  return 0;
}
static int notify(void *engine,void *command,void *packet,void *context,void *actor,void *flags) {
  (void)engine;(void)command;(void)flags;
  int result=send_notification(packet,context,actor,"notifysfulabprobe ok=1");
  event("{\"event\":\"sfulabnotify-handler-called\"}\n");
  return result;
}
static int send_target(void *actor,unsigned target,const char *message) {
  if(!actor || !*(void **)actor || !target || target>65535)return 256;
  unsigned char text[24]={0};size_t n=strlen(message);
  if(n<=22){text[0]=(unsigned char)(n*2);memcpy(text+1,message,n+1);}
  else{size_t capacity=(n+2)|1;memcpy(text,&capacity,8);memcpy(text+8,&n,8);memcpy(text+16,&message,8);}
  void *out=((void *(*)(size_t))(base+0x17ed054))(0xb0);
  ((void (*)(void *,void *,unsigned))(base+0xf1142c))(out,text,target);
  ((void (*)(void *,void *,unsigned,void *))(base+0xb9ee90))(*(void **)actor,out,9,NULL);
  return 0;
}
// Routing probe only, disabled in preview. This follows the original
// setupstream broadcast path at bad6ac..bad6c0 / bad668..bad678.
static int notify_target(void *engine,void *command,void *packet,void *context,void *actor,void *flags) {
  (void)engine;(void)command;(void)context;(void)flags;
  if(!actor || !*(void **)actor || !packet)return 256;
  char *raw=NULL;int length=0;
  ((void (*)(void *,char **,int *))(base+0xf0b798))(packet,&raw,&length);
  if(!raw || length<=0 || length>256)return 256;
  const char *field=memmem(raw,(size_t)length," clid=",6);
  if(!field)return 256;
  const char *cur=field+6,*end=raw+length;unsigned target=0,digits=0;
  while(cur<end && *cur>='0' && *cur<='9') {
    if(++digits>5)return 256;
    target=target*10+(unsigned)(*cur++-'0');
  }
  if(!digits || !target || target>65535 || (cur<end && *cur!=' '))return 256;
  int result=send_target(actor,target,"notifysfulabprobe ok=1");
  event("{\"event\":\"sfulab-target-notification\"}\n");return result;
}
static long millis(void) {
  struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);
  return ts.tv_sec*1000L+ts.tv_nsec/1000000L;
}
static int ready(int fd,short events,long deadline) {
  for(;;) {
    long left=deadline-millis();if(left<=0)return 0;
    struct pollfd p={fd,events,0};int n=poll(&p,1,(int)left);
    if(n<0 && errno==EINTR)continue;
    return n>0 && (p.revents&events);
  }
}
static int access_info(void *engine,void *command,void *packet,void *context,void *actor,void *flags) {
  (void)engine;(void)command;(void)flags;
  const char *secret=getenv("SFU_BRIDGE_SECRET");
  if(!secret || strlen(secret)!=64 || strspn(secret,"0123456789abcdef")!=64 || !packet)return 256;
  char *raw=NULL;int raw_length=0;char return_code[257];
  ((void (*)(void *,char **,int *))(base+0xf0b798))(packet,&raw,&raw_length);
  if(raw_length<=0 || !copy_return_code(raw,(size_t)raw_length,return_code,sizeof(return_code)))return 256;
  unsigned client=((unsigned (*)(void *))(base+0xf098bc))(packet);
  if(!client || client>65535)return 256;
  int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);if(fd<0)return 256;
  struct sockaddr_un address={.sun_family=AF_UNIX};
  strcpy(address.sun_path,"/sfu-trace/access.sock");
  long deadline=millis()+1200;
  if(connect(fd,(void *)&address,sizeof(address))<0) {
    if(errno!=EINPROGRESS || !ready(fd,POLLOUT,deadline))goto failed;
    int error=0;socklen_t size=sizeof(error);
    if(getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&size)<0 || error)goto failed;
  }
  char request[96];int length=snprintf(request,sizeof(request),"%s %u\n",secret,client);
  size_t sent=0;
  while(sent<(size_t)length) {
    if(!ready(fd,POLLOUT,deadline))goto failed;
    ssize_t n=send(fd,request+sent,(size_t)length-sent,MSG_NOSIGNAL);
    if(n<0 && (errno==EINTR || errno==EAGAIN))continue;
    if(n<=0)goto failed;
    sent+=(size_t)n;
  }
  char response[640]={0};size_t used=0;
  while(used<sizeof(response)-1) {
    if(!ready(fd,POLLIN,deadline))goto failed;
    ssize_t n=recv(fd,response+used,sizeof(response)-1-used,0);
    if(n<0 && (errno==EINTR || errno==EAGAIN))continue;
    if(n<=0)goto failed;
    used+=(size_t)n;if(memchr(response,'\n',used))break;
  }
  if(used<67 || response[64]!=' ' || response[used-1]!='\n')goto failed;
  response[64]=0;response[used-1]=0;
  if(strspn(response,"0123456789abcdef")!=64)goto failed;
  /* Backend supplies one bounded, TS-escaped identifier, not a command. */
  for(size_t i=65;i<used-1;i++)if((unsigned char)response[i]<=32 || response[i]=='|' || (unsigned char)response[i]>=127)goto failed;
  close(fd);
  char message[1024];
  snprintf(message,sizeof(message),"notifysfuaccessinfo sfu_token=%s sfu_user=%s%s%s",response,response+65,
    return_code[0]?" return_code=":"",return_code);
  int result=send_notification(packet,context,actor,message);
  event("{\"event\":\"access-info-issued\"}\n");
  if(return_code[0])event("{\"event\":\"access-info-correlated\"}\n");
  return result;
failed:
  close(fd);event("{\"event\":\"access-info-unavailable\"}\n");return 256;
}

typedef int (*command_handler)(void *,void *,void *,void *,void *,void *);
static command_handler original_setup,original_stop,original_info;
static int stream_exchange(unsigned client,const char *raw,size_t length,char *response,size_t capacity) {
  const char *secret=getenv("SFU_BRIDGE_SECRET");
  if(!secret || strlen(secret)!=64 || strspn(secret,"0123456789abcdef")!=64 || !length || length>2048)return 0;
  char request[4300];int prefix=snprintf(request,sizeof(request),"%s %u stream ",secret,client);
  const char hex[]="0123456789abcdef";
  for(size_t i=0;i<length;i++) { unsigned c=(unsigned char)raw[i];request[prefix+i*2]=hex[c>>4];request[prefix+i*2+1]=hex[c&15]; }
  size_t total=prefix+length*2;request[total++]='\n';
  int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);if(fd<0)return 0;
  struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,"/sfu-trace/access.sock");
  long deadline=millis()+1200;
  if(connect(fd,(void *)&address,sizeof(address))<0) {
    if(errno!=EINPROGRESS || !ready(fd,POLLOUT,deadline))goto failed;
    int error=0;socklen_t size=sizeof(error);
    if(getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&size)<0 || error)goto failed;
  }
  for(size_t sent=0;sent<total;) {
    if(!ready(fd,POLLOUT,deadline))goto failed;
    ssize_t n=send(fd,request+sent,total-sent,MSG_NOSIGNAL);
    if(n<0 && (errno==EINTR || errno==EAGAIN))continue;
    if(n<=0)goto failed;
    sent+=(size_t)n;
  }
  size_t used=0;
  while(used+1<capacity) {
    if(!ready(fd,POLLIN,deadline))goto failed;
    ssize_t n=recv(fd,response+used,capacity-used-1,0);
    if(n<0 && (errno==EINTR || errno==EAGAIN))continue;
    if(n<=0)goto failed;
    used+=(size_t)n;
    char *newline=memchr(response,'\n',used);
    if(newline) {
      if(newline!=response+used-1)goto failed;
      *newline=0;close(fd);return 1;
    }
  }
failed:
  close(fd);return 0;
}
static int flush_notifications(void *engine,void *command,void *packet,void *context,void *actor,void *flags) {
  (void)engine;(void)command;(void)context;(void)flags;
  if(!packet)return 256;
  unsigned client=((unsigned (*)(void *))(base+0xf098bc))(packet);
  char response[4096];
  if(!stream_exchange(client,"sfulabflush",11,response,sizeof(response)))return 256;
  if(strncmp(response,"D ",2))return 2568;
  const char *end=response+2;unsigned target=0,digits=0;
  while(*end>='0' && *end<='9'){
    if(++digits>5)return 256;
    target=target*10+(unsigned)(*end++-'0');
  }
  if(!digits || !target || target>65535 || *end!=' ')return 256;
  const char *message=end+1;
  if(strncmp(message,"notifystreamstarted ",20) && strncmp(message,"notifystreamstopped ",20)
     && strncmp(message,"notifyclientupdated ",20))return 256;
  int result=send_target(actor,(unsigned)target,message);
  event("{\"event\":\"sfu-channel-notification\"}\n");return result;
}
static int stream_command(int kind,void *engine,void *command,void *packet,void *context,void *actor,void *flags) {
  command_handler fallback=__atomic_load_n(kind==2?&original_info:kind==1?&original_setup:&original_stop,__ATOMIC_ACQUIRE);
  if(!packet || !fallback)return 256;
  char *raw=NULL;int length=0;
  ((void (*)(void *,char **,int *))(base+0xf0b798))(packet,&raw,&length);
  if(!raw || length<=0 || length>2048 || memchr(raw,0,(size_t)length))return 256;
  // Preserve P2P and unsupported-mode handling in the original server.
  if(kind==1) {
    const char *mode=memmem(raw,(size_t)length," mode=2",7);
    if(!mode || (mode+7<raw+length && mode[7]!=' '))return fallback(engine,command,packet,context,actor,flags);
  }
  unsigned client=((unsigned (*)(void *))(base+0xf098bc))(packet);
  if(!client || client>65535)return 256;
  char response[4096];
  if(!stream_exchange(client,raw,(size_t)length,response,sizeof(response)))return 256;
  if(!strcmp(response,"P"))return fallback(engine,command,packet,context,actor,flags);
  if(!strcmp(response,"E 2568"))return 2568;
  if(!strncmp(response,"N notifystream",14)) {
    int result=send_notification(packet,context,actor,response+2);
    event(kind==2?"{\"event\":\"sfu-stream-info\"}\n":kind==1?"{\"event\":\"sfu-stream-started\"}\n":"{\"event\":\"sfu-stream-stopped\"}\n");
    return result;
  }
  return 256;
}
static int setup_stream(void *e,void *c,void *p,void *x,void *a,void *f) {return stream_command(1,e,c,p,x,a,f);}
static int stop_stream(void *e,void *c,void *p,void *x,void *a,void *f) {return stream_command(0,e,c,p,x,a,f);}
static int stream_info(void *e,void *c,void *p,void *x,void *a,void *f) {return stream_command(2,e,c,p,x,a,f);}

static void *lookup(void *map,const struct span *key) {
  int is_ping=key && key->size==10 && !memcmp(key->data,"sfulabping",10);
  int is_flush=key && key->size==11 && !memcmp(key->data,"sfulabflush",11) && getenv("SFU_NOTIFICATION_RELAY");
  int is_notify=key && key->size==12 && !memcmp(key->data,"sfulabnotify",12);
  int is_target=key && key->size==18 && !memcmp(key->data,"sfulabnotifytarget",18) && getenv("SFU_ROUTING_PROBE");
  int is_access=key && key->size==20 && !memcmp(key->data,"requestsfuaccessinfo",20) && getenv("SFU_BRIDGE_SECRET");
  if(is_ping || is_notify || is_access || is_target || is_flush) {
    const struct span reference={"clientupdate",12};
    void *known=original_lookup(map,&reference);
    if(!known)return NULL;
    memcpy(entry,known,sizeof(entry));
    // Observed Itanium member function representation at node+0x28:
    // callback and encoded this-adjustment. Inherit existing admission flags.
    uintptr_t callback=(uintptr_t)(is_ping?&ping:is_notify?&notify:is_target?&notify_target:is_flush?&flush_notifications:&access_info),adjustment=0;
    memcpy(entry+0x28,&callback,8);memcpy(entry+0x30,&adjustment,8);
    return entry;
  }
  void *found=original_lookup(map,key);
  int setup=key && key->size==11 && !memcmp(key->data,"setupstream",11);
  int stop=key && key->size==10 && !memcmp(key->data,"stopstream",10);
  int info=key && key->size==17 && !memcmp(key->data,"requeststreaminfo",17)
    && getenv("SFU_VIEWER_CONTROL_ENABLED");
  if(found && (setup || stop || info) && getenv("SFU_CONTROL_ENABLED")) {
    uintptr_t function=0,adjustment=0;
    memcpy(&function,(char *)found+0x28,8);memcpy(&adjustment,(char *)found+0x30,8);
    if(adjustment || (setup && function!=base+0xd8c384))return found;
    __atomic_store_n(info?&original_info:setup?&original_setup:&original_stop,(command_handler)function,__ATOMIC_RELEASE);
    memcpy(entry,found,sizeof(entry));
    uintptr_t callback=(uintptr_t)(info?&stream_info:setup?&setup_stream:&stop_stream);
    memcpy(entry+0x28,&callback,8);
    return entry;
  }
  return found;
}
static void jump(unsigned char *at,void *target) {
  const uint32_t op[2]={0x58000050,0xd61f0200};
  memcpy(at,op,8);memcpy(at+8,&target,8);
}

static void *(*original_packet)(void *,void *,unsigned);
static void *packet_constructor(void *packet,void *text,unsigned client) {
  const unsigned char *str=text;size_t length=str[0]>>1;const char *data=(void *)(str+1);
  if(str[0]&1) {memcpy(&length,str+8,8);memcpy(&data,str+16,8);}
  if(length<11 || length>65536 || memcmp(data,"initserver ",11))return original_packet(packet,text,client);
  const char prefix[]=" virtualserver_capability_extensions=";
  const char *field=memmem(data,length,prefix,sizeof(prefix)-1);
  if(!field)return original_packet(packet,text,client);
  const char *value=field+sizeof(prefix)-1,*end=memchr(value,' ',(size_t)(data+length-value));
  if(!end)end=data+length;
  if(memmem(value,(size_t)(end-value),"STREAM_SFU",10))return original_packet(packet,text,client);
  const char suffix[]=",STREAM_SFU";size_t extra=sizeof(suffix)-1,new_length=length+extra;
  char *changed=malloc(new_length+1);if(!changed)return original_packet(packet,text,client);
  size_t before=(size_t)(end-data);memcpy(changed,data,before);memcpy(changed+before,suffix,extra);
  memcpy(changed+before+extra,end,length-before);changed[new_length]=0;
  unsigned char view[24];size_t capacity=(new_length+2)|1;
  memcpy(view,&capacity,8);memcpy(view+8,&new_length,8);memcpy(view+16,&changed,8);
  void *result=original_packet(packet,view,client);free(changed);
  event("{\"event\":\"publisher-preview-capability-sent\"}\n");
  return result;
}
static void install_publisher_preview(void) {
  const char *enabled=getenv("SFU_PUBLISHER_PREVIEW");
  if(!enabled || strcmp(enabled,"1") || !getenv("SFU_CONTROL_ENABLED") || !getenv("SFU_BRIDGE_SECRET"))return;
  unsigned char *target=(void *)(base+0xf1142c);
  const unsigned char expected[16]={0xfd,0x7b,0xbd,0xa9,0xf5,0x0b,0x00,0xf9,0xf4,0x4f,0x02,0xa9,0xfd,0x03,0x00,0x91};
  if(memcmp(target,expected,16))return;
  unsigned char *trampoline=mmap(NULL,4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(trampoline==MAP_FAILED)return;
  memcpy(trampoline,target,16);jump(trampoline+16,target+16);
  __builtin___clear_cache((char *)trampoline,(char *)trampoline+32);
  if(mprotect(trampoline,4096,PROT_READ|PROT_EXEC))return;
  original_packet=(void *)trampoline;
  size_t page=(size_t)sysconf(_SC_PAGESIZE);void *start=(void *)((uintptr_t)target&~(page-1));
  if(mprotect(start,page,PROT_READ|PROT_WRITE|PROT_EXEC))return;
  jump(target,(void *)&packet_constructor);__builtin___clear_cache((char *)target,(char *)target+16);
  if(mprotect(start,page,PROT_READ|PROT_EXEC))return;
  event("{\"event\":\"publisher-preview-installed\"}\n");
}

__attribute__((constructor)) static void install(void) {
  log_fd=open("/sfu-trace/extension.jsonl",O_WRONLY|O_APPEND|O_CLOEXEC);
  dl_iterate_phdr(locate,NULL);
  if(!pinned) {event("{\"event\":\"unsupported-build\"}\n");return;}
  unsigned char *target=(void *)(base+0xc238d4);
  const unsigned char expected[16]={0xfd,0x7b,0xbb,0xa9,0xfa,0x67,0x01,0xa9,0xf8,0x5f,0x02,0xa9,0xf6,0x57,0x03,0xa9};
  if(memcmp(target,expected,16)) {event("{\"event\":\"opcode-mismatch\"}\n");return;}
  unsigned char *trampoline=mmap(NULL,4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(trampoline==MAP_FAILED)return;
  memcpy(trampoline,target,16);jump(trampoline+16,target+16);
  __builtin___clear_cache((char *)trampoline,(char *)trampoline+32);
  if(mprotect(trampoline,4096,PROT_READ|PROT_EXEC))return;
  original_lookup=(void *)trampoline;
  size_t page=(size_t)sysconf(_SC_PAGESIZE);
  void *start=(void *)((uintptr_t)target&~(page-1));
  if(mprotect(start,page,PROT_READ|PROT_WRITE|PROT_EXEC))return;
  jump(target,(void *)&lookup);
  __builtin___clear_cache((char *)target,(char *)target+16);
  if(mprotect(start,page,PROT_READ|PROT_EXEC))return;
  install_publisher_preview();
  event("{\"event\":\"extension-installed\",\"commands\":[\"sfulabping\",\"sfulabnotify\"]}\n");
}
