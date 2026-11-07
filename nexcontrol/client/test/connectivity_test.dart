import 'package:flutter_test/flutter_test.dart';
import 'package:nexcontrol_v3/vps_connection.dart';

void main() {
  test('SSH host validation blocks URLs and malformed destination', () {
    expect(validVpsHost('31.56.85.53'),isTrue);
    expect(validVpsHost('vps.example.com'),isTrue);
    expect(validVpsHost('http://malicious.example'),isFalse);
    expect(validVpsHost('host@attacker'),isFalse);
    expect(validVpsHost('../etc/passwd'),isFalse);
    expect(validVpsHost(''),isFalse);
  });

  test('Profile metadata does not serialize credentials', () {
    final profile=VpsProfile(id:'1',label:'Main',host:'192.0.2.4',port:2222,
      username:'tresor',method:'ssh_key',remember:true);
    final map=profile.toJson();
    expect(map.containsKey('password'),false);
    expect(map.containsKey('privateKey'),false);
    expect(VpsProfile.fromJson(map).target,'tresor@192.0.2.4:2222');
  });
}
