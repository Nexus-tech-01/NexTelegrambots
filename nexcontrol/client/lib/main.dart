import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:url_launcher/url_launcher.dart';
import 'vps_connection.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const NexControl());
}

const bg=Color(0xFF080F1B);
const panel=Color(0xFF111E31);
const border=Color(0xFF2C405B);
const accent=Color(0xFF61D4CB);

class NexControl extends StatelessWidget {
  const NexControl({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner:false,
    title:'NexControl',
    theme:ThemeData(
      brightness:Brightness.dark,useMaterial3:true,
      scaffoldBackgroundColor:bg,
      colorScheme:ColorScheme.fromSeed(seedColor:accent,brightness:Brightness.dark,
        surface:panel,primary:accent),
      inputDecorationTheme:InputDecorationTheme(
        filled:true,fillColor:const Color(0xFF0C1726),
        contentPadding:const EdgeInsets.symmetric(horizontal:16,vertical:16),
        border:OutlineInputBorder(borderRadius:BorderRadius.circular(15)),
        enabledBorder:OutlineInputBorder(borderRadius:BorderRadius.circular(15),
          borderSide:const BorderSide(color:border)),
      ),
      cardTheme:CardThemeData(color:panel,
        shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(20),
          side:const BorderSide(color:border))),
    ),
    home:const Home(),
  );
}

class Home extends StatefulWidget {
  const Home({super.key});
  @override
  State<Home> createState()=>_HomeState();
}

class _HomeState extends State<Home> {
  final storage=SavedProfiles(const FlutterSecureStorage());
  late final connector=VpsConnector(storage);
  final username=TextEditingController();
  final password=TextEditingController();
  final privateKey=TextEditingController();
  final passphrase=TextEditingController();
  final shellCommand=TextEditingController();
  final pathController=TextEditingController(text:'/home');
  final hostController=TextEditingController();
  final labelController=TextEditingController();
  final portController=TextEditingController(text:'22');
  final newUsername=TextEditingController();
  final _apiOutput=TextEditingController();
  List<VpsProfile> profiles=[];
  VpsProfile profile=VpsProfile(
    id:'default',label:'VPS principal',
    host:const String.fromEnvironment('NXC_DEFAULT_HOST',defaultValue:'31.56.85.53'),
    port:22,username:'');
  ConnectedVps? connected;
  String _method='password';
  String _result='';
  String _message='';
  bool _busy=false;
  bool _remember=false;
  bool _obscure=true;
  bool _initializing=true;
  int _tab=0;
  final sections=const ['Vue générale','Terminal','Fichiers','Accès','Services'];

  @override
  void initState(){super.initState();_load();}
  Future<void> _load() async {
    try{
      final loaded=await storage.load();
      if(loaded.isNotEmpty){
        profiles=loaded;
        profile=profiles.first;
      }
      await _prepareProfile();
    }catch(e){_message='Impossible de restaurer les profils : $e';}
    if(mounted)setState(()=>_initializing=false);
  }

  Future<void> _prepareProfile() async {
    username.text=profile.username;
    _method=profile.method;
    _remember=profile.remember;
    password.clear();privateKey.clear();passphrase.clear();
    final saved=await storage.loadSecret(profile);
    if(saved!=null){
      if(profile.method=='ssh_key')privateKey.text=saved.secret;
      else password.text=saved.secret;
      passphrase.text=saved.passphrase;
    }
  }

  @override
  void dispose(){
    username.dispose();password.dispose();privateKey.dispose();passphrase.dispose();
    shellCommand.dispose();pathController.dispose();hostController.dispose();
    labelController.dispose();portController.dispose();newUsername.dispose();_apiOutput.dispose();
    connected?.close();
    super.dispose();
  }

  void _report(String value){if(mounted)setState(()=>_message=value);}
  void _busySet(bool b){if(mounted)setState(()=>_busy=b);}

  Future<void> _selectProfile(VpsProfile p) async {
    await connected?.close();
    connected=null;
    profile=p;
    _tab=0;_result='';_message='';
    await _prepareProfile();
    if(mounted)setState((){});
  }

  Future<bool> _trustHost(String type,String fingerprint) async {
    if(!mounted)return false;
    final result=await showDialog<bool>(context:context,builder:(ctx)=>
      AlertDialog(
        title:const Text('Vérifier l’identité du serveur'),
        content:SelectableText(
          'L’adresse '+profile.host+' a présenté cette empreinte :\n\n'+
          type+'  '+fingerprint+
          '\n\nCompare-la avec l’empreinte SSH obtenue directement auprès de l’hébergeur. '
          'N’accepte pas une empreinte inconnue : elle pourrait appartenir à un imposteur.'),
        actions:[
          TextButton(onPressed:()=>Navigator.pop(ctx,false),child:const Text('Refuser')),
          FilledButton(onPressed:()=>Navigator.pop(ctx,true),
            child:const Text('J’ai vérifié l’empreinte')),
        ],
      ));
    return result==true;
  }

  Future<void> _connect() async {
    if(_busy)return;
    final candidate=profile;
    candidate.username=username.text.trim();
    candidate.method=_method;
    candidate.remember=_remember;
    if(candidate.username.isEmpty && _method!='legacy_api'){
      _report('Renseigne ton nom utilisateur SSH.');return;
    }
    final credential=_method=='ssh_key'?privateKey.text:password.text;
    if(credential.isEmpty){_report('Renseigne le mot de passe, la clé privée ou la clé API.');return;}
    _busySet(true);_report('Connexion à '+candidate.host+'…');
    try{
      if(_method=='legacy_api'){
        final result=await LegacyVps.check(candidate,credential);
        _apiOutput.text=result;
        _result=result;
      }else{
        connected=await connector.connect(profile:candidate,secret:credential,
          passphrase:passphrase.text,verifyFirstKey:_trustHost);
        _result=await connected!.overview();
      }
      if(!profiles.any((x)=>x.id==candidate.id)){
        if(candidate.id=='default'){
          final p=VpsProfile(id:DateTime.now().microsecondsSinceEpoch.toString(),
            label:candidate.label,host:candidate.host,port:candidate.port,
            username:candidate.username,method:candidate.method,remember:candidate.remember);
          profile=p;
          profiles.insert(0,p);
        }else{profiles.insert(0,candidate);}
      }
      await storage.save(profiles);
      await storage.saveSecret(profile,credential,passphrase.text);
      if(!_remember){password.clear();privateKey.clear();passphrase.clear();}
      if(mounted)setState((){_tab=0;_message='Connecté à '+profile.target;});
    }catch(e){_report('Connexion refusée : $e');}
    finally{_busySet(false);}
  }

  Future<void> _run(String command) async {
    final c=connected;if(c==null)return;
    if(command.trim().isEmpty)return;
    _busySet(true);
    try{
      final out=await c.run(command);
      if(mounted)setState(()=>_result=r'$ '+command+'\n'+out);
    }catch(e){_report('Commande échouée : $e');}
    finally{_busySet(false);}
  }

  Future<void> _section(int index) async {
    _tab=index;
    if(mounted)setState(()=>_result='Chargement…');
    if(connected==null){
      _result=_apiOutput.text;
      if(mounted)setState((){});
      return;
    }
    _busySet(true);
    try{
      final c=connected!;
      String out='';
      switch(index){
        case 0:out=await c.overview();break;
        case 1:out='Saisis une commande Linux puis touche Exécuter.';break;
        case 2:
          final entries=await c.listFiles(pathController.text.trim().isEmpty?'/':pathController.text.trim());
          out=entries.join('\n');break;
        case 3:out=await c.accessReport();break;
        case 4:out=await c.services();break;
      }
      if(mounted)setState(()=>_result=out);
    }catch(e){_report('Chargement impossible : $e');}
    finally{_busySet(false);}
  }

  Future<void> _fullAccessInventory() async {
    if(connected==null || _busy)return;
    final sudoPassword=TextEditingController();
    final accepted=await showDialog<bool>(context:context,builder:(dialog)=>AlertDialog(
      title:const Text('Inventaire complet des accès'),
      content:SizedBox(width:420,child:Column(mainAxisSize:MainAxisSize.min,children:[
        const Text('Le VPS demandera une authentification sudo. '
          'Le mot de passe sera transmis sur la connexion SSH chiffrée, sans être enregistré.'),
        const SizedBox(height:16),
        TextField(controller:sudoPassword,obscureText:true,
          decoration:const InputDecoration(labelText:'Mot de passe sudo')),
      ])),
      actions:[
        TextButton(onPressed:()=>Navigator.pop(dialog,false),child:const Text('Annuler')),
        FilledButton(onPressed:()=>Navigator.pop(dialog,true),child:const Text('Afficher les accès')),
      ],
    ));
    if(accepted!=true){sudoPassword.dispose();return;}
    _busySet(true);
    try{
      final report=await connected!.fullAccessInventory(sudoPassword.text);
      if(mounted)setState(()=>_result=report);
    }catch(e){_report('Inventaire protégé indisponible : $e');}
    finally{sudoPassword.clear();sudoPassword.dispose();_busySet(false);}
  }

  Future<void> _addServer() async {
    labelController.text='Mon VPS';
    hostController.clear();portController.text='22';
    newUsername.clear();
    final result=await showDialog<VpsProfile>(context:context,builder:(dialog)=>
      AlertDialog(
        title:const Text('Ajouter un nouveau VPS'),
        scrollable:true,
        content:SizedBox(width:440,child:Column(mainAxisSize:MainAxisSize.min,children:[
          const Align(alignment:Alignment.centerLeft,child:Text(
            'Informations SSH du VPS. Les identifiants seront utilisés directement depuis cet appareil.',
            style:TextStyle(color:Color(0xFF9CAFC8)))),
          const SizedBox(height:16),
          TextField(controller:labelController,decoration:const InputDecoration(labelText:'Nom du VPS')),
          const SizedBox(height:12),
          TextField(controller:hostController,decoration:const InputDecoration(
            labelText:'Adresse IP ou domaine',hintText:'exemple.com ou 192.0.2.10')),
          const SizedBox(height:12),
          TextField(controller:portController,
            keyboardType:TextInputType.number,decoration:const InputDecoration(labelText:'Port SSH (22)')),
          const SizedBox(height:12),
          TextField(controller:newUsername,decoration:const InputDecoration(
            labelText:'Utilisateur Linux',hintText:'root, ubuntu, tresor…')),
        ])),
        actions:[
          TextButton(onPressed:()=>Navigator.pop(dialog),child:const Text('Annuler')),
          FilledButton(onPressed:(){
            final port=int.tryParse(portController.text.trim());
            final host=hostController.text.trim();
            if(!validVpsHost(host) || port==null || port<1 || port>65535 ||
               !userPattern.hasMatch(newUsername.text.trim())){
              ScaffoldMessenger.of(dialog).showSnackBar(const SnackBar(
                content:Text('Adresse, port ou utilisateur SSH invalide.')));
              return;
            }
            Navigator.pop(dialog,VpsProfile(
              id:DateTime.now().microsecondsSinceEpoch.toString(),
              label:labelController.text.trim().isEmpty?host:labelController.text.trim(),
              host:host,port:port,username:newUsername.text.trim()));
          },child:const Text('Ajouter')),
        ],
      ));
    if(result!=null){profiles.insert(0,result);await storage.save(profiles);await _selectProfile(result);}
  }

  Future<void> _chooseVps() async {
    await showModalBottomSheet<void>(context:context,isScrollControlled:true,
      builder:(ctx)=>SafeArea(child:Padding(padding:const EdgeInsets.all(18),
        child:Column(mainAxisSize:MainAxisSize.min,children:[
          const Text('Mes VPS',style:TextStyle(fontSize:22,fontWeight:FontWeight.bold)),
          const SizedBox(height:12),
          ...profiles.map((p)=>ListTile(
            leading:const Icon(Icons.dns_rounded),
            title:Text(p.label),subtitle:Text(p.target),
            onTap:(){Navigator.pop(ctx);_selectProfile(p);},
          )),
          ListTile(leading:const Icon(Icons.add_circle_outline),title:const Text('Ajouter un nouveau VPS'),
            onTap:(){Navigator.pop(ctx);_addServer();}),
        ]))));
  }

  Future<void> _forgetHost() async {
    final ok=await showDialog<bool>(context:context,builder:(ctx)=>AlertDialog(
      title:const Text('Supprimer l’empreinte SSH ?'),
      content:const Text('Une nouvelle empreinte devra être vérifiée auprès de l’hébergeur. '
        'Ne fais cela que si la clé SSH du serveur a réellement changé.'),
      actions:[TextButton(onPressed:()=>Navigator.pop(ctx,false),child:const Text('Annuler')),
        TextButton(onPressed:()=>Navigator.pop(ctx,true),child:const Text('Supprimer'))]));
    if(ok==true){await storage.forgetHost(profile);_report('Empreinte oubliée. Vérification nécessaire au prochain accès.');}
  }

  Future<void> _openOldConsole() async {
    final uri=Uri.parse('https://nxc.31-56-85-53.sslip.io/nexcontrol/');
    if(!await launchUrl(uri,mode:LaunchMode.externalApplication)){
      _report('Impossible d’ouvrir la console web.');
    }
  }

  Widget _pill(IconData icon,String label,{VoidCallback? onTap})=>TextButton.icon(
    onPressed:onTap,icon:Icon(icon,size:18),label:Text(label),
    style:TextButton.styleFrom(foregroundColor:const Color(0xFFA9BECF)));

  Widget _header() => Row(children:[
    Container(width:43,height:43,decoration:BoxDecoration(
      color:accent.withValues(alpha:.12),borderRadius:BorderRadius.circular(14)),
      child:const Icon(Icons.hub_rounded,color:accent)),
    const SizedBox(width:12),
    const Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      Text('NEXCONTROL',style:TextStyle(fontWeight:FontWeight.w900,fontSize:21,letterSpacing:1.2)),
      Text('Contrôle sécurisé de tes serveurs',style:TextStyle(color:Color(0xFF99ADC4),fontSize:12)),
    ])),
    IconButton(tooltip:'Mes VPS',onPressed:_chooseVps,icon:const Icon(Icons.dns_outlined)),
  ]);

  Widget _login() => Center(child:SingleChildScrollView(
    padding:const EdgeInsets.fromLTRB(20,24,20,40),
    child:ConstrainedBox(constraints:const BoxConstraints(maxWidth:520),
      child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
        _header(),const SizedBox(height:26),
        Container(padding:const EdgeInsets.all(24),
          decoration:BoxDecoration(
            color:panel,borderRadius:BorderRadius.circular(24),
            border:Border.all(color:border),
            boxShadow:const [BoxShadow(color:Color(0x66000000),blurRadius:28,offset:Offset(0,12))]),
          child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
            const Text('Bienvenue',style:TextStyle(fontSize:30,fontWeight:FontWeight.w800)),
            const SizedBox(height:6),
            Text('Connecte-toi au VPS « '+profile.label+' »',
              style:const TextStyle(color:Color(0xFF99ADC4))),
            const SizedBox(height:22),
            TextField(controller:username,enabled:_method!='legacy_api',
              decoration:const InputDecoration(labelText:'Nom d’utilisateur',prefixIcon:Icon(Icons.person_outline))),
            const SizedBox(height:14),
            DropdownButtonFormField<String>(
              key:ValueKey(_method),initialValue:_method,
              decoration:const InputDecoration(labelText:'Méthode de connexion',prefixIcon:Icon(Icons.key_rounded)),
              items:const [
                DropdownMenuItem(value:'password',child:Text('Mot de passe SSH')),
                DropdownMenuItem(value:'ssh_key',child:Text('Clé privée SSH')),
                DropdownMenuItem(value:'legacy_api',child:Text('Ancienne clé API NexControl')),
              ],
              onChanged:(v){if(v!=null)setState(()=>_method=v);}),
            const SizedBox(height:14),
            if(_method=='ssh_key') ...[
              TextField(controller:privateKey,minLines:3,maxLines:6,
                decoration:const InputDecoration(labelText:'Clé privée SSH (PEM/OpenSSH)',
                  hintText:'-----BEGIN OPENSSH PRIVATE KEY-----')),
              const SizedBox(height:12),
              TextField(controller:passphrase,obscureText:true,
                decoration:const InputDecoration(labelText:'Phrase secrète de la clé (si nécessaire)')),
            ] else TextField(controller:password,obscureText:_obscure,
                decoration:InputDecoration(
                  labelText:_method=='legacy_api'?'Clé API NexControl':'Mot de passe SSH',
                  prefixIcon:const Icon(Icons.lock_outline),
                  suffixIcon:IconButton(onPressed:()=>setState(()=>_obscure=!_obscure),
                    icon:Icon(_obscure?Icons.visibility_outlined:Icons.visibility_off_outlined)))),
            const SizedBox(height:14),
            SwitchListTile.adaptive(contentPadding:EdgeInsets.zero,value:_remember,
              title:const Text('Mémoriser cet accès sur cet appareil'),
              subtitle:const Text('Chiffré dans le stockage sécurisé du système'),
              onChanged:(v)=>setState(()=>_remember=v)),
            const SizedBox(height:16),
            FilledButton.icon(
              onPressed:_busy?null:_connect,
              icon:_busy?const SizedBox(width:16,height:16,
                child:CircularProgressIndicator(strokeWidth:2)):const Icon(Icons.login_rounded),
              label:Text(_busy?'Connexion…':'Se connecter'),
              style:FilledButton.styleFrom(padding:const EdgeInsets.symmetric(vertical:17))),
            const SizedBox(height:22),
            Center(child:TextButton(onPressed:_addServer,
              child:const Text('Pas ce VPS ? Ajouter un nouveau VPS',
                style:TextStyle(fontSize:12,color:Color(0xFF9AAFC9))))),
          ])),
        const SizedBox(height:12),
        Text('Hôte : '+profile.host+'  •  SSH '+profile.port.toString(),
          textAlign:TextAlign.center,style:const TextStyle(color:Color(0xFF8CA2B9),fontSize:12)),
        const SizedBox(height:10),
        Wrap(alignment:WrapAlignment.center,children:[
          _pill(Icons.switch_account_outlined,'Changer de VPS',onTap:_chooseVps),
          _pill(Icons.open_in_new,'Ancienne console',onTap:_openOldConsole),
          _pill(Icons.verified_user_outlined,'Empreinte SSH',onTap:_forgetHost),
        ]),
        if(_message.isNotEmpty) Padding(padding:const EdgeInsets.only(top:12),
          child:SelectableText(_message,textAlign:TextAlign.center,
            style:const TextStyle(color:Color(0xFFF7C991)))),
      ]))),
  );

  Widget _dashboard() {
    final width=MediaQuery.sizeOf(context).width;
    final wide=width>=850;
    final nav=NavigationRail(
      extended:width>1100,
      selectedIndex:_tab,
      onDestinationSelected:(v)=>_section(v),
      labelType:width>1100?NavigationRailLabelType.none:NavigationRailLabelType.all,
      destinations:const [
        NavigationRailDestination(icon:Icon(Icons.dashboard_outlined),label:Text('Vue générale')),
        NavigationRailDestination(icon:Icon(Icons.terminal),label:Text('Terminal')),
        NavigationRailDestination(icon:Icon(Icons.folder_outlined),label:Text('Fichiers')),
        NavigationRailDestination(icon:Icon(Icons.group_outlined),label:Text('Accès')),
        NavigationRailDestination(icon:Icon(Icons.settings_applications_outlined),label:Text('Services')),
      ]);
    final content=Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      Padding(padding:const EdgeInsets.fromLTRB(18,16,18,8),child:Row(children:[
        const Icon(Icons.dns_rounded,color:accent),const SizedBox(width:10),
        Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
          Text(profile.label,style:const TextStyle(fontSize:22,fontWeight:FontWeight.bold)),
          Text(profile.target,style:const TextStyle(color:Color(0xFF9BB0C8),fontSize:12)),
        ])),
        IconButton(onPressed:_busy?null:()=>_section(_tab),tooltip:'Actualiser',icon:const Icon(Icons.refresh)),
        IconButton(onPressed:()async{
          await connected?.close();
          if(mounted)setState((){connected=null;_apiOutput.clear();_result='';_message='Déconnecté volontairement.';});
        },tooltip:'Déconnexion',icon:const Icon(Icons.logout)),
      ])),
      if(_busy)const LinearProgressIndicator(minHeight:2),
      Padding(padding:const EdgeInsets.symmetric(horizontal:18,vertical:10),
        child:Row(children:[
          const Icon(Icons.lock_outline,size:16,color:accent),
          const SizedBox(width:7),
          Expanded(child:Text(connected!=null?'SSH chiffré · Clé hôte vérifiée':
            'Ancienne API NexControl · HTTPS',
            style:const TextStyle(color:Color(0xFFB2C7D9),fontSize:12))),
        ])),
      if(_tab==3)Padding(padding:const EdgeInsets.symmetric(horizontal:18),
        child:Text('Comptes Linux, sessions et relais techniques visibles selon tes droits. '
          'Cette vue ne couvre pas nécessairement tous les accès de l’hébergeur.',
          style:TextStyle(color:Colors.amber.shade200,fontSize:12))),
      if(_tab==3 && connected!=null)Padding(
        padding:const EdgeInsets.symmetric(horizontal:18,vertical:8),
        child:Align(alignment:Alignment.centerLeft,child:FilledButton.icon(
          onPressed:_busy?null:_fullAccessInventory,
          icon:const Icon(Icons.admin_panel_settings_outlined),
          label:const Text('Inventaire complet (sudo)'),
        ))),
      if(_tab==1 && connected!=null)Padding(padding:const EdgeInsets.all(18),child:Row(children:[
        Expanded(child:TextField(controller:shellCommand,
          decoration:const InputDecoration(labelText:'Commande Linux',hintText:'pwd, ls -lah, systemctl status…'),
          onSubmitted:(v)=>_run(v))),
        const SizedBox(width:10),
        FilledButton(onPressed:_busy?null:()=>_run(shellCommand.text),child:const Text('Exécuter')),
      ])),
      if(_tab==2 && connected!=null)Padding(padding:const EdgeInsets.all(18),child:Row(children:[
        Expanded(child:TextField(controller:pathController,
          decoration:const InputDecoration(labelText:'Chemin SFTP',hintText:'/home/tresor'))),
        const SizedBox(width:10),
        FilledButton(onPressed:_busy?null:()=>_section(2),child:const Text('Ouvrir')),
      ])),
      Expanded(child:SingleChildScrollView(padding:const EdgeInsets.fromLTRB(18,10,18,18),
        child:Container(width:double.infinity,padding:const EdgeInsets.all(18),
          decoration:BoxDecoration(color:panel,border:Border.all(color:border),
            borderRadius:BorderRadius.circular(18)),
          child:SelectableText(_result.isEmpty?'Aucune donnée reçue.':_result,
            style:const TextStyle(fontFamily:'monospace',fontSize:12,height:1.5))))),
      if(_message.isNotEmpty)Padding(padding:const EdgeInsets.fromLTRB(18,0,18,8),
        child:Text(_message,style:const TextStyle(fontSize:12,color:Color(0xFFF7C991)))),
    ]);
    return Scaffold(
      body:SafeArea(child:wide?Row(children:[nav,const VerticalDivider(width:1),Expanded(child:content)]):content),
      bottomNavigationBar:wide?null:NavigationBar(
        selectedIndex:_tab,onDestinationSelected:_section,
        destinations:const [
          NavigationDestination(icon:Icon(Icons.dashboard_outlined),label:'Accueil'),
          NavigationDestination(icon:Icon(Icons.terminal),label:'Terminal'),
          NavigationDestination(icon:Icon(Icons.folder_outlined),label:'Fichiers'),
          NavigationDestination(icon:Icon(Icons.group_outlined),label:'Accès'),
          NavigationDestination(icon:Icon(Icons.settings_outlined),label:'Services'),
        ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    if(_initializing)return const Scaffold(body:Center(child:CircularProgressIndicator()));
    if(connected!=null || _apiOutput.text.isNotEmpty)return _dashboard();
    return Scaffold(body:SafeArea(child:_login()));
  }
}
