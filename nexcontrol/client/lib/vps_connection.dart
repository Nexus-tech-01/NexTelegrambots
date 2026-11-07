import 'dart:convert';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

final hostPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$');
final userPattern = RegExp(r'^[a-zA-Z_][a-zA-Z0-9_.-]{0,39}$');

bool validVpsHost(String host) => host.isNotEmpty && host.length <= 253 &&
    hostPattern.hasMatch(host) && !host.contains('..') &&
    !host.endsWith('.') && !host.contains('/') &&
    !host.contains('@') && !host.contains(' ');

class VpsProfile {
  VpsProfile({required this.id, required this.label, required this.host,
    required this.port, required this.username,
    this.method = 'password', this.remember = false});
  final String id;
  String label, host, username, method;
  int port;
  bool remember;

  Map<String, dynamic> toJson() => {'id':id,'label':label,'host':host,'port':port,
    'username':username,'method':method,'remember':remember};
  factory VpsProfile.fromJson(Map<String,dynamic> data) => VpsProfile(
    id:data['id'] as String? ?? '',
    label:data['label'] as String? ?? 'VPS',
    host:data['host'] as String? ?? '',
    port:(data['port'] as num?)?.toInt() ?? 22,
    username:data['username'] as String? ?? '',
    method:data['method'] as String? ?? 'password',
    remember:data['remember'] == true);
  String get target => '$username@$host:$port';
}

class SavedProfiles {
  SavedProfiles(this.secure);
  final FlutterSecureStorage secure;
  static const listKey='nxc-v3-profiles';
  Future<List<VpsProfile>> load() async {
    final value=await secure.read(key:listKey);
    if(value==null || value.isEmpty) return [];
    try {
      return (jsonDecode(value) as List).map((x)=>
        VpsProfile.fromJson(Map<String,dynamic>.from(x as Map))).toList();
    } catch (_) {return [];}
  }
  Future<void> save(List<VpsProfile> profiles) =>
    secure.write(key:listKey,value:jsonEncode(profiles.map((x)=>x.toJson()).toList()));
  String credentialKey(VpsProfile p)=>'nxc-v3-auth-'+p.id;
  Future<void> saveSecret(VpsProfile p,String secret,String passphrase) async {
    if(p.remember) {
      await secure.write(key:credentialKey(p),value:jsonEncode(
        {'secret':secret,'passphrase':passphrase}));
    } else {await secure.delete(key:credentialKey(p));}
  }
  Future<({String secret,String passphrase})?> loadSecret(VpsProfile p) async {
    if(!p.remember)return null;
    final value=await secure.read(key:credentialKey(p));
    if(value==null)return null;
    try{
      final obj=Map<String,dynamic>.from(jsonDecode(value) as Map);
      return (secret:obj['secret'] as String? ?? '',passphrase:obj['passphrase'] as String? ?? '');
    }catch(_){return null;}
  }
  Future<void> remove(VpsProfile p)=>secure.delete(key:credentialKey(p));
  String hostKey(VpsProfile p)=>'nxc-v3-hostkey-'+p.host.toLowerCase()+':'+p.port.toString();
  Future<String?> knownHost(VpsProfile p)=>secure.read(key:hostKey(p));
  Future<void> trustHost(VpsProfile p,String key)=>secure.write(key:hostKey(p),value:key);
  Future<void> forgetHost(VpsProfile p)=>secure.delete(key:hostKey(p));
}

class ConnectedVps {
  ConnectedVps(this.profile,this.ssh);
  final VpsProfile profile;
  final SSHClient ssh;
  Future<String> run(String command) async {
    final out=await ssh.run(command).timeout(const Duration(seconds:45));
    return utf8.decode(out,allowMalformed:true);
  }
  Future<String> overview() => run(
    "printf 'SERVEUR\\n'; hostname; "
    "printf '\\nUTILISATEUR\\n'; id; "
    "printf '\\nSYSTÈME\\n'; uname -sr; "
    "printf '\\nCHARGE\\n'; uptime; "
    "printf '\\nMÉMOIRE\\n'; free -h | head -3; "
    "printf '\\nDISQUE\\n'; df -h / | tail -1;");
  Future<String> accessReport()=>run(
    "printf 'COMPTE CONNECTÉ\\n'; id; "
    "printf '\\nCOMPTES LINUX\\n'; "
    r'''getent passwd | awk -F: '($3==0 || ($3>=1000 && $3<65534)){print $1, "UID=" $3, "shell=" $7}' '''
    "; printf '\\nGROUPES ADMIN\\n'; getent group sudo docker | cut -d: -f1,4; "
    "printf '\\nSESSIONS SSH ACTIVES\\n'; who; "
    "printf '\\nPONTS NEXCONTROL\\n'; "
    "systemctl is-active nxc-oidc-vps.service nexcontrol-mobile.service nxc-vps-gateway.service 2>/dev/null || true; "
    "printf '\\nSERVICE CHATGPT\\n'; "
    "if test -r /var/lib/nexcontrol-identity/accounts.sqlite3; then "
    "python3 -c 'import sqlite3; c=sqlite3.connect(\"file:/var/lib/nexcontrol-identity/accounts.sqlite3?mode=ro\",uri=True); "
    "print(list(c.execute(\"select username,kind,role from principals\")))'; "
    "else printf 'Registre protégé : consulter avec les droits propriétaire.\\n'; fi");
  Future<String> fullAccessInventory(String sudoPassword) async {
    // The sudo password is transmitted only through SSH process stdin,
    // never a command argument, URL, repository issue or application log.
    const py = r'''
import grp,json,os,pathlib,pwd,sqlite3,time
out={'generatedAt':int(time.time()),'linuxAccounts':[],'mobileApiKeys':[],
     'webDevices':[],'technicalKeys':[],'principals':[],'recentOidc':[]}
try: sudo=set(grp.getgrnam('sudo').gr_mem)
except KeyError: sudo=set()
for u in pwd.getpwall():
    if u.pw_uid!=0 and not (1000<=u.pw_uid<65534): continue
    key=pathlib.Path(u.pw_dir)/'.ssh'/'authorized_keys'
    try: count=sum(1 for ln in key.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith('#')) if key.is_file() and not key.is_symlink() else 0
    except OSError: count=-1
    out['linuxAccounts'].append({'user':u.pw_name,'uid':u.pw_uid,'sudo':u.pw_uid==0 or u.pw_name in sudo,'sshKeys':count,'shell':u.pw_shell})
def read(path,sql):
    if not os.path.isfile(path):return []
    con=sqlite3.connect('file:'+path+'?mode=ro',uri=True,timeout=4)
    con.row_factory=sqlite3.Row
    try:return [dict(row) for row in con.execute(sql).fetchall()]
    except sqlite3.Error:return []
    finally:con.close()
out['mobileApiKeys']=read('/var/lib/nexcontrol-mobile/access.sqlite3','select id,label,scopes,created,expires from keys')
out['webDevices']=read('/var/lib/nxc-vps/gateway.sqlite3','select id,label,kind,last_seen,revoked from devices')
out['technicalKeys']=read('/var/lib/nxc-vps/gateway.sqlite3','select id,label,role,expires,revoked from assistant_keys')
out['principals']=read('/var/lib/nexcontrol-identity/accounts.sqlite3','select username,kind,role,status from principals')
out['recentOidc']=read('/var/lib/nxc-oidc-vps/audit.sqlite3','select issue,created,action,state from operations order by created desc limit 20')
out['coverage']='Le panneau VPS externe et les délégations non enregistrées ne peuvent pas être inventoriés ici.'
print(json.dumps(out,ensure_ascii=False,indent=2))
''';
    if (sudoPassword.isEmpty) {
      throw const FormatException('Mot de passe sudo nécessaire.');
    }
    final encoded=base64Encode(utf8.encode(py));
    final command="sudo -S -p '' python3 -c 'import base64;exec(base64.b64decode(\"$encoded\"))'";
    final session=await ssh.execute(command);
    final stdout=BytesBuilder(),stderr=BytesBuilder();
    final stdoutDone=session.stdout.listen((x)=>stdout.add(x)).asFuture<void>();
    final stderrDone=session.stderr.listen((x)=>stderr.add(x)).asFuture<void>();
    try {
      session.write(Uint8List.fromList(utf8.encode(sudoPassword+'\n')));
      await session.stdin.close();
      await session.done.timeout(const Duration(seconds:50));
      await Future.wait([stdoutDone,stderrDone]);
      if(session.exitCode!=0)throw StateError(
        'Lecture avec sudo refusée : '+utf8.decode(stderr.takeBytes(),allowMalformed:true));
      return utf8.decode(stdout.takeBytes(),allowMalformed:true);
    } finally {
      // Do not retain the password, token, or SSH command output in persistent storage.
    }
  }
  Future<String> services() => run(
    'systemctl list-units --type=service --state=running --no-pager --plain | head -65');
  Future<List<String>> listFiles(String path) async {
    final sftp=await ssh.sftp();
    try{return (await sftp.listdir(path)).map((x)=>x.longname).toList();}
    finally{await sftp.close();}
  }
  Future<void> close()=>ssh.close();
}

class VpsConnector {
  VpsConnector(this.storage);
  final SavedProfiles storage;
  Future<ConnectedVps> connect({
    required VpsProfile profile,
    required String secret,
    String passphrase='',
    required Future<bool> Function(String keyType,String fingerprint) verifyFirstKey,
  }) async {
    if(!validVpsHost(profile.host) || profile.port<1 || profile.port>65535){
      throw const FormatException('Adresse ou port VPS invalide.');
    }
    if(!userPattern.hasMatch(profile.username)){
      throw const FormatException('Nom utilisateur SSH invalide.');
    }
    if(profile.method=='legacy_api'){
      throw const FormatException('Sélectionner le mode API pour cette clé.');
    }
    final known=await storage.knownHost(profile);
    String? confirmed;
    final socket=await SSHSocket.connect(profile.host,profile.port)
      .timeout(const Duration(seconds:18));
    try{
      final identities=profile.method=='ssh_key'
        ? SSHKeyPair.fromPem(secret,passphrase.isEmpty?null:passphrase)
        : <SSHKeyPair>[];
      final client=SSHClient(socket,username:profile.username,
        identities:identities,
        onPasswordRequest:profile.method=='password'?()=>secret:null,
        onVerifyHostKey:(type,bytes)async{
          final fingerprint=utf8.decode(bytes);
          final canonical='$type $fingerprint';
          if(known!=null)return known==canonical;
          if(await verifyFirstKey(type.toString(),fingerprint)){
            confirmed=canonical;
            return true;
          }
          return false;
        });
      try{
        await client.authenticated.timeout(const Duration(seconds:25));
        if(confirmed!=null)await storage.trustHost(profile,confirmed!);
        return ConnectedVps(profile,client);
      }catch(_){await client.close();rethrow;}
    }catch(_){socket.close();rethrow;}
  }
}

class LegacyVps {
  static Future<String> check(VpsProfile profile,String key) async {
    if(!validVpsHost(profile.host))throw const FormatException('Serveur invalide');
    final domain=profile.host=='31.56.85.53'?'nxc.31-56-85-53.sslip.io':profile.host;
    final uri=Uri.https(domain,'/nexcontrol-mobile/status');
    final response=await http.get(uri,headers:{
      'Authorization':'Bearer $key','Accept':'application/json'
    }).timeout(const Duration(seconds:15));
    if(response.statusCode==401)throw const FormatException('Clé expirée ou révoquée.');
    if(response.statusCode>=400)throw FormatException('HTTP '+response.statusCode.toString());
    return const JsonEncoder.withIndent('  ').convert(jsonDecode(response.body));
  }
}
