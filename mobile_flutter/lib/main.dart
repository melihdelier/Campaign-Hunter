import 'package:flutter/material.dart';
import 'models/models.dart';
import 'services/demo_data.dart';
import 'services/engine.dart';

void main() => runApp(const CampaignHunterApp());

class CampaignHunterApp extends StatelessWidget {
  const CampaignHunterApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    title: 'Banka Kampanya Avcısı',
    theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF111827)), useMaterial3: true),
    home: const HomePage(),
  );
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int index = 0;
  late Map<String, CampaignState> states;
  final amount = TextEditingController(text: '12000');
  String category = 'restoran';
  List<CardRecommendation> results = const [];

  @override
  void initState() { super.initState(); states = Map.of(demoStates); }
  @override
  void dispose() { amount.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final views = [overview(), campaigns(), recommendView()];
    return Scaffold(
      appBar: AppBar(title: const Text('Banka Kampanya Avcısı'), actions: const [Padding(padding: EdgeInsets.only(right:16), child: Center(child: Text('Kart numarası tutulmaz', style: TextStyle(fontSize:12))))]),
      body: SafeArea(child: views[index]),
      bottomNavigationBar: NavigationBar(selectedIndex:index, onDestinationSelected:(v)=>setState(()=>index=v), destinations: const [
        NavigationDestination(icon:Icon(Icons.dashboard_outlined), label:'Özet'),
        NavigationDestination(icon:Icon(Icons.local_offer_outlined), label:'Kampanyalar'),
        NavigationDestination(icon:Icon(Icons.credit_card), label:'Hangi Kart?'),
      ]),
    );
  }

  Widget overview() => ListView(padding: const EdgeInsets.all(16), children:[
    Card(color: Colors.orange.shade50, child: const Padding(padding:EdgeInsets.all(14), child:Text('v0.2: Alt limit ve işlem/dönem tavanları kampanya detaylarından okunur. Web prototipinde kart/segment/işyeri koşulları da değerlendirilir.'))),
    const SizedBox(height:12),
    Text('Kartlarım', style:Theme.of(context).textTheme.titleLarge),
    const SizedBox(height:8),
    ...demoCards.map((c)=>Card(child:ListTile(title:Text('${c.bank} — ${c.name}'), subtitle:Text(c.segment), trailing:const Icon(Icons.chevron_right)))),
  ]);

  Widget campaigns() => ListView(padding: const EdgeInsets.all(16), children:[
    Text('Kampanyalar', style:Theme.of(context).textTheme.titleLarge),
    const Text('Kalan limiti manuel doğrulayabilirsin. Dönem değişirse otomatik reset uygulanır.'),
    const SizedBox(height:12),
    ...demoCampaigns.map((c){
      final s = ensureReset(c, states[c.id], DateTime.now());
      states[c.id] = s;
      return Card(child:Padding(padding:const EdgeInsets.all(14), child:Column(crossAxisAlignment:CrossAxisAlignment.start, children:[
        Row(children:[Expanded(child:Text(c.title, style:const TextStyle(fontWeight:FontWeight.w700))), if(c.demo) const Chip(label:Text('DEMO'))]),
        Text('${c.bank} · ${c.category}'),
        const SizedBox(height:8),
        Text('Kalan hak: ${s.remainingLimit == null ? 'Bilinmiyor' : '${s.remainingLimit!.toStringAsFixed(0)} TL'}'),
        Text('Kaynak: ${sourceLabel(s.valueSource)}'),
        const SizedBox(height:8),
        Wrap(spacing:8, children:[
          OutlinedButton(onPressed:()=>editLimit(c,s), child:const Text('Kalan hakkı güncelle')),
          if(c.requiresEnrollment) OutlinedButton(onPressed:()=>setState(()=>states[c.id]=s.copyWith(enrollmentStatus:s.enrollmentStatus==EnrollmentStatus.joined?EnrollmentStatus.unknown:EnrollmentStatus.joined, updatedAt:DateTime.now())), child:Text(s.enrollmentStatus==EnrollmentStatus.joined?'Katılımı geri al':'Katıldım')),
        ])
      ])));
    })
  ]);

  Widget recommendView() => ListView(padding:const EdgeInsets.all(16), children:[
    Text('Hangi kart?', style:Theme.of(context).textTheme.titleLarge),
    const Text('Bilmediğimiz kalan limit varsa kesin kazanç yerine teorik avantaj gösterilir.'),
    const SizedBox(height:12),
    DropdownButtonFormField<String>(value:category, decoration:const InputDecoration(labelText:'Kategori', border:OutlineInputBorder()), items:const [
      DropdownMenuItem(value:'restoran',child:Text('Restoran')), DropdownMenuItem(value:'giyim',child:Text('Giyim')), DropdownMenuItem(value:'seyahat',child:Text('Seyahat')), DropdownMenuItem(value:'market',child:Text('Market')),
    ], onChanged:(v)=>setState(()=>category=v??'restoran')),
    const SizedBox(height:10),
    TextField(controller:amount, keyboardType:const TextInputType.numberWithOptions(decimal:true), decoration:const InputDecoration(labelText:'Tutar (TL)', border:OutlineInputBorder())),
    const SizedBox(height:10),
    FilledButton(onPressed:runRecommendation, child:const Text('Kartları karşılaştır')),
    const SizedBox(height:14),
    ...results.asMap().entries.map((entry){
      final r=entry.value; final b=r.best;
      return Card(child:ListTile(
        leading:CircleAvatar(child:Text('${entry.key+1}')),
        title:Text('${r.card.bank} — ${r.card.name}'),
        subtitle:b==null?const Text('Uygun kampanya bulunamadı'):Text('${b.campaign.title}\n${rewardLabel(b)}'),
      ));
    })
  ]);

  void runRecommendation() {
    final a=double.tryParse(amount.text.replaceAll(',','.'));
    if(a==null || a<=0){ ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content:Text('Geçerli tutar gir.'))); return; }
    setState(()=>results=recommend(cards:demoCards,campaigns:demoCampaigns,states:states,category:category,amount:a,now:DateTime.now()));
  }

  Future<void> editLimit(Campaign c, CampaignState s) async {
    final controller=TextEditingController(text:s.remainingLimit?.toStringAsFixed(0)??'');
    final value=await showDialog<double?>(context:context,builder:(ctx)=>AlertDialog(
      title:Text(c.title), content:TextField(controller:controller, keyboardType:const TextInputType.numberWithOptions(decimal:true), decoration:const InputDecoration(labelText:'Kalan hak (boş = bilinmiyor)')),
      actions:[TextButton(onPressed:()=>Navigator.pop(ctx),child:const Text('Vazgeç')), FilledButton(onPressed:(){ final raw=controller.text.trim(); if(raw.isEmpty){Navigator.pop(ctx,double.nan);return;} Navigator.pop(ctx,double.tryParse(raw.replaceAll(',','.')));},child:const Text('Kaydet'))]
    ));
    if(!mounted || value==null) return;
    setState(()=>states[c.id]=s.copyWith(remainingLimit:value.isNaN?null:value,setRemainingNull:value.isNaN,valueSource:ValueSource.userConfirmed,confirmedAt:DateTime.now(),updatedAt:DateTime.now()));
  }

  String sourceLabel(ValueSource s)=>switch(s){ValueSource.userConfirmed=>'Kullanıcı doğruladı',ValueSource.systemEstimated=>'Sistem tahmini',ValueSource.reset=>'Otomatik reset'};
  String rewardLabel(CampaignEvaluation e){
    if(e.enrollmentMissing) return 'Katılım gerekli · teorik ${e.theoreticalReward.toStringAsFixed(0)} TL';
    if(!e.remainingKnown) return 'Teorik ${e.theoreticalReward.toStringAsFixed(0)} TL · kalan limit bilinmiyor';
    return 'Hesaplanan avantaj ${e.actualReward!.toStringAsFixed(0)} TL · kalan ${e.state.remainingLimit!.toStringAsFixed(0)} TL';
  }
}
