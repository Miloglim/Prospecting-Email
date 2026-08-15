// ── 组件化句库 v2 ──────────────────────────────────────────────
// 正式商务语气，长篇幅。无具体人名、无具体航线。
// {a|b|c} → 随机选词。{{company}} → 可选公司名占位。

export type Lang = "EN" | "ES" | "PT";
export type ClientType = "direct" | "peer" | "general";
export type Stage = "initial" | "followup1" | "followup2" | "closing" | "reactivate";

type Pool = Record<string, string[]>;

// ══════════════════════════════════════════════════════════════
// 1. salutation — 正式称呼
// ══════════════════════════════════════════════════════════════
const salutation: Pool = {
  "EN": [
    "{Dear Sir or Madam|Dear Director|To whom it may concern},",
    "{Dear Sir or Madam|Dear Director},",
    "{To the attention of the Director|Dear Director},",
  ],
  "ES": [
    "{Estimado/a Director/a|A quien corresponda},",
    "{Estimado/a Director/a|Estimados señores},",
    "{A la atención del Director/a|Estimado/a Director/a},",
  ],
  "PT": [
    "{Prezado/a Diretor/a|A quem possa interessar},",
    "{Prezado/a Diretor/a|Prezados senhores},",
    "{À atenção do/a Diretor/a|Prezado/a Diretor/a},",
  ],
};

// ══════════════════════════════════════════════════════════════
// 2. pleasantry — 开场问候
// ══════════════════════════════════════════════════════════════
const pleasantry: Pool = {
  "EN": [
    "I hope this message finds you well.",
    "I trust this message reaches you in good spirits.",
    "Allow me to introduce myself and the organization I represent.",
  ],
  "ES": [
    "Espero que este mensaje le encuentre bien.",
    "Confío en que este mensaje le llegue en buen momento.",
    "Permítame presentarme a mí mismo y a la organización que represento.",
  ],
  "PT": [
    "Espero que esta mensagem o/a encontre bem.",
    "Espero que esta mensagem chegue em boa hora.",
    "Permita-me apresentar a mim mesmo e à organização que represento.",
  ],
};

// ══════════════════════════════════════════════════════════════
// 3. intro — 自我介绍（无具体人名）
// ══════════════════════════════════════════════════════════════
const intro: Pool = {
  "direct.EN": [
    "I represent YQN Logistics, an international freight forwarding company. Our organization specializes in providing comprehensive logistics solutions for businesses engaged in international trade, with a strong focus on reliability, operational excellence, and personalized service.",
    "I am writing on behalf of YQN Logistics, a professional freight forwarding firm dedicated to supporting international trade operations. We offer end-to-end logistics services designed to streamline supply chain management and reduce operational complexity for our clients.",
    "Allow me to introduce YQN Logistics — a freight forwarding company committed to delivering dependable international shipping solutions. Our team works closely with importers and exporters to ensure efficient cargo movement, clear communication, and consistent service quality.",
    "I represent YQN Logistics, a company focused on international freight forwarding and supply chain support. We pride ourselves on building long-term partnerships through transparent communication, competitive solutions, and a genuine commitment to our clients' success.",
  ],
  "direct.ES": [
    "Represento a YQN Logistics, una empresa de forwarding internacional. Nuestra organización se especializa en proveer soluciones logísticas integrales para empresas dedicadas al comercio internacional, con un fuerte enfoque en confiabilidad, excelencia operativa y servicio personalizado.",
    "Escribo en nombre de YQN Logistics, una firma profesional de freight forwarding dedicada a apoyar operaciones de comercio internacional. Ofrecemos servicios logísticos integrales diseñados para optimizar la cadena de suministro y reducir la complejidad operativa de nuestros clientes.",
    "Permítame presentarle YQN Logistics — una empresa de forwarding comprometida con ofrecer soluciones de envío internacional confiables. Nuestro equipo trabaja estrechamente con importadores y exportadores para garantizar un movimiento de carga eficiente y comunicación clara.",
    "Represento a YQN Logistics, una empresa enfocada en forwarding internacional y soporte a la cadena de suministro. Nos enorgullece construir relaciones a largo plazo mediante comunicación transparente, soluciones competitivas y un genuino compromiso con el éxito de nuestros clientes.",
  ],
  "direct.PT": [
    "Represento a YQN Logistics, uma empresa de freight forwarding internacional. Nossa organização é especializada em fornecer soluções logísticas abrangentes para empresas envolvidas no comércio internacional, com forte foco em confiabilidade, excelência operacional e serviço personalizado.",
    "Escrevo em nome da YQN Logistics, uma empresa profissional de freight forwarding dedicada a apoiar operações de comércio internacional. Oferecemos serviços logísticos completos, projetados para otimizar a gestão da cadeia de suprimentos e reduzir a complexidade operacional de nossos clientes.",
    "Permita-me apresentar a YQN Logistics — uma empresa de freight forwarding comprometida em oferecer soluções confiáveis de envio internacional. Nossa equipe trabalha em estreita colaboração com importadores e exportadores para garantir eficiência e comunicação clara.",
    "Represento a YQN Logistics, uma empresa focada em freight forwarding internacional e suporte à cadeia de suprimentos. Temos orgulho em construir parcerias de longo prazo por meio de comunicação transparente, soluções competitivas e um compromisso genuíno com o sucesso de nossos clientes.",
  ],
  "peer.EN": [
    "I represent YQN Logistics, a freight forwarding company that collaborates with fellow logistics providers to extend service capabilities and offer competitive solutions. Our model is built on partnership — we support your operations without competing for your client relationships.",
    "I am writing from YQN Logistics, where we focus on being a reliable capacity partner for other forwarders. We provide competitive buy rates and dependable service, allowing our partners to serve their clients more effectively while maintaining full control of the customer relationship.",
    "Allow me to introduce YQN Logistics from the perspective of partnership. We are a freight forwarding firm that works behind the scenes — providing the rates, capacity, and operational support that help other forwarders win and retain business.",
    "YQN Logistics operates as a dedicated partner to fellow freight forwarders. We believe in strengthening your capabilities, not competing with them. Our role is to be the reliable backup that gives you more options when serving your clients.",
  ],
  "peer.ES": [
    "Represento a YQN Logistics, una empresa de freight forwarding que colabora con otros proveedores logísticos para ampliar capacidades de servicio y ofrecer soluciones competitivas. Nuestro modelo se basa en la colaboración — apoyamos sus operaciones sin competir por sus relaciones con clientes.",
    "Escribo desde YQN Logistics, donde nos enfocamos en ser un socio de capacidad confiable para otros forwarders. Proveemos tarifas competitivas y servicio confiable, permitiendo a nuestros socios servir a sus clientes de manera más efectiva manteniendo el control total de la relación.",
    "Permítame presentar YQN Logistics desde la perspectiva de la colaboración. Somos una firma de freight forwarding que trabaja en segundo plano — proveyendo las tarifas, capacidad y soporte operativo que ayudan a otros forwarders a ganar y retener negocios.",
    "YQN Logistics opera como un socio dedicado para otros forwarders. Creemos en fortalecer sus capacidades, no en competir con ellas. Nuestro rol es ser el respaldo confiable que le da más opciones al servir a sus clientes.",
  ],
  "peer.PT": [
    "Represento a YQN Logistics, uma empresa de freight forwarding que colabora com outros provedores logísticos para ampliar capacidades de serviço e oferecer soluções competitivas. Nosso modelo é baseado em parceria — apoiamos suas operações sem competir por seus relacionamentos com clientes.",
    "Escrevo da YQN Logistics, onde nos concentramos em ser um parceiro de capacidade confiável para outros forwarders. Fornecemos tarifas competitivas e serviço confiável, permitindo que nossos parceiros sirvam seus clientes de forma mais eficaz, mantendo o controle total do relacionamento.",
    "Permita-me apresentar a YQN Logistics sob a perspectiva da parceria. Somos uma empresa de freight forwarding que trabalha nos bastidores — fornecendo as tarifas, a capacidade e o suporte operacional que ajudam outros forwarders a conquistar e reter negócios.",
    "A YQN Logistics opera como um parceiro dedicado para outros forwarders. Acreditamos em fortalecer suas capacidades, não em competir com elas. Nosso papel é ser o respaldo confiável que lhe dá mais opções ao atender seus clientes.",
  ],
  "general.EN": [
    "I represent YQN Logistics, an international freight forwarding company. We provide comprehensive logistics solutions designed to support businesses engaged in or exploring international trade opportunities.",
    "I am writing on behalf of YQN Logistics, a professional freight forwarding organization. Our focus is on delivering reliable international shipping solutions with a commitment to service quality and operational transparency.",
    "Allow me to introduce YQN Logistics — a freight forwarding company dedicated to helping businesses navigate the complexities of international shipping with confidence and efficiency.",
    "I represent YQN Logistics, a company focused on international freight forwarding and supply chain support. We work with businesses to streamline logistics operations and reduce the challenges associated with cross-border trade.",
  ],
  "general.ES": [
    "Represento a YQN Logistics, una empresa de freight forwarding internacional. Proveemos soluciones logísticas integrales diseñadas para apoyar a empresas involucradas o explorando oportunidades de comercio internacional.",
    "Escribo en nombre de YQN Logistics, una organización profesional de freight forwarding. Nuestro enfoque es ofrecer soluciones confiables de envío internacional con un compromiso con la calidad de servicio y transparencia operativa.",
    "Permítame presentar YQN Logistics — una empresa de freight forwarding dedicada a ayudar a empresas a navegar las complejidades del envío internacional con confianza y eficiencia.",
    "Represento a YQN Logistics, una empresa enfocada en forwarding internacional y soporte a la cadena de suministro. Trabajamos con empresas para optimizar operaciones logísticas y reducir los desafíos del comercio transfronterizo.",
  ],
  "general.PT": [
    "Represento a YQN Logistics, uma empresa de freight forwarding internacional. Fornecemos soluções logísticas abrangentes projetadas para apoiar empresas envolvidas ou explorando oportunidades de comércio internacional.",
    "Escrevo em nome da YQN Logistics, uma organização profissional de freight forwarding. Nosso foco é fornecer soluções confiáveis de envio internacional com compromisso com a qualidade do serviço e transparência operacional.",
    "Permita-me apresentar a YQN Logistics — uma empresa de freight forwarding dedicada a ajudar empresas a navegar pelas complexidades do envio internacional com confiança e eficiência.",
    "Represento a YQN Logistics, uma empresa focada em freight forwarding internacional e suporte à cadeia de suprimentos. Trabalhamos com empresas para otimizar operações logísticas e reduzir os desafios do comércio internacional.",
  ],
};

// ══════════════════════════════════════════════════════════════
// 4. discovery — 认知来源（可控是否提及公司）
// ══════════════════════════════════════════════════════════════
const discovery: Pool = {
  "direct.EN": [
    "I came across {{company}} through my ongoing research into key participants in the international trade sector. The presence and reputation of your organization made a strong impression, and I felt compelled to reach out and explore how we might be of service.",
    "I have been following {{company}}'s activities in the logistics and trade space with considerable interest. Your organization's standing in the industry is noteworthy, and I believe there may be meaningful opportunities for collaboration.",
    "{{company}} was brought to my attention through industry channels, and I was impressed by the scope and professionalism of your operations. It seemed appropriate to introduce ourselves and explore whether a partnership could be mutually beneficial.",
  ],
  "direct.ES": [
    "Conocí a {{company}} a través de mi investigación continua sobre actores clave en el sector del comercio internacional. La presencia y reputación de su organización me causaron una fuerte impresión, y me sentí motivado a contactarles para explorar cómo podríamos ser de servicio.",
    "He estado siguiendo las actividades de {{company}} en el espacio logístico y comercial con considerable interés. La posición de su organización en la industria es notable, y creo que pueden existir oportunidades significativas de colaboración.",
    "{{company}} llegó a mi conocimiento a través de canales del sector, y quedé impresionado por el alcance y profesionalismo de sus operaciones. Me pareció apropiado presentarnos y explorar si una colaboración podría ser mutuamente beneficiosa.",
  ],
  "direct.PT": [
    "Conheci a {{company}} através de minha pesquisa contínua sobre participantes-chave no setor de comércio internacional. A presença e a reputação de sua organização causaram uma forte impressão, e me senti motivado a entrar em contato para explorar como poderíamos ser úteis.",
    "Venho acompanhando as atividades da {{company}} no espaço logístico e comercial com considerável interesse. A posição de sua organização no setor é notável, e acredito que possam existir oportunidades significativas de colaboração.",
    "A {{company}} chegou ao meu conhecimento através de canais do setor, e fiquei impressionado com o escopo e profissionalismo de suas operações. Pareceu-me apropriado nos apresentar e explorar se uma parceria poderia ser mutuamente benéfica.",
  ],
  "peer.EN": [
    "I became aware of {{company}}'s work through industry networks, and your reputation as a capable and professional logistics provider precedes you. As a fellow forwarder, I believe there is potential for us to complement each other's capabilities.",
    "{{company}} is well-regarded in forwarding circles, and I have long been interested in establishing a connection. I see clear opportunities for us to work together in a way that benefits both organizations without any conflict of interest.",
    "Through conversations with industry colleagues, {{company}}'s name has come up repeatedly — and always in a positive light. I wanted to reach out personally and explore whether a partnership could add value to both of our operations.",
  ],
  "peer.ES": [
    "Tomé conocimiento del trabajo de {{company}} a través de redes del sector, y su reputación como un proveedor logístico capaz y profesional les precede. Como colega forwarder, creo que existe potencial para complementar nuestras capacidades mutuamente.",
    "{{company}} es bien considerada en círculos de forwarding, y desde hace tiempo he tenido interés en establecer una conexión. Veo oportunidades claras para trabajar juntos de manera que beneficie a ambas organizaciones sin conflicto de intereses.",
    "A través de conversaciones con colegas del sector, el nombre de {{company}} ha surgido repetidamente — y siempre de manera positiva. Quería contactarles personalmente para explorar si una colaboración podría agregar valor a ambas operaciones.",
  ],
  "peer.PT": [
    "Tomei conhecimento do trabalho da {{company}} através de redes do setor, e sua reputação como um provedor logístico capaz e profissional os precede. Como colega forwarder, acredito que existe potencial para complementarmos nossas capacidades mutuamente.",
    "A {{company}} é bem considerada nos círculos de forwarding, e há muito tempo tenho interesse em estabelecer uma conexão. Vejo oportunidades claras para trabalharmos juntos de forma que beneficie ambas as organizações sem conflito de interesses.",
    "Através de conversas com colegas do setor, o nome da {{company}} surgiu repetidamente — e sempre de forma positiva. Queria entrar em contato pessoalmente para explorar se uma parceria poderia agregar valor a ambas as operações.",
  ],
  "general.EN": [
    "I came across your organization while researching the international trade landscape, and was impressed by what I learned. I wanted to reach out and introduce our company in case our services could be of value to your operations.",
    "Your organization was brought to my attention through professional channels, and I was struck by the quality and scope of your work. I felt it would be worthwhile to connect and explore whether our capabilities align with your needs.",
  ],
  "general.ES": [
    "Conocí a su organización mientras investigaba el panorama del comercio internacional, y quedé impresionado por lo que aprendí. Quería contactarles para presentar nuestra empresa por si nuestros servicios pudieran ser de valor para sus operaciones.",
    "Su organización llegó a mi conocimiento a través de canales profesionales, y me impresionó la calidad y el alcance de su trabajo. Me pareció que valía la pena conectar y explorar si nuestras capacidades se alinean con sus necesidades.",
  ],
  "general.PT": [
    "Conheci sua organização enquanto pesquisava o cenário do comércio internacional, e fiquei impressionado com o que aprendí. Quería entrar em contato para apresentar nossa empresa, caso nossos serviços possam ser de valor para suas operações.",
    "Sua organização chegou ao meu conhecimento através de canais profissionais, e fiquei impressionado com a qualidade e o escopo do seu trabalho. Achei que valeria a pena conectar e explorar se nossas capacidades se alinham às suas necessidades.",
  ],
};

// ══════════════════════════════════════════════════════════════
// 5. bridge — 价值连接
// ══════════════════════════════════════════════════════════════
const bridge: Pool = {
  "direct.EN": [
    "I believe there exists a genuine opportunity to establish a strategic partnership between our organizations. With our expertise in international freight forwarding and your established presence in the market, a collaboration could generate meaningful value for both parties.",
    "Having reviewed the scope and nature of your operations, I am confident that our logistics capabilities can complement your business effectively. A partnership could unlock efficiencies, reduce costs, and enhance service levels across your supply chain.",
    "It is my conviction that we could contribute positively to your international logistics operations. The combination of our specialized freight services and your market expertise presents a compelling case for collaboration.",
  ],
  "direct.ES": [
    "Creo que existe una oportunidad genuina de establecer una alianza estratégica entre nuestras organizaciones. Con nuestra experiencia en freight forwarding internacional y su presencia establecida en el mercado, una colaboración podría generar valor significativo para ambas partes.",
    "Habiendo revisado el alcance y la naturaleza de sus operaciones, confío en que nuestras capacidades logísticas pueden complementar su negocio de manera efectiva. Una alianza podría desbloquear eficiencias, reducir costos y mejorar los niveles de servicio en su cadena de suministro.",
    "Es mi convicción que podríamos contribuir positivamente a sus operaciones logísticas internacionales. La combinación de nuestros servicios de carga especializados y su experiencia en el mercado presenta un caso convincente para la colaboración.",
  ],
  "direct.PT": [
    "Acredito que existe uma oportunidade genuína de estabelecer uma parceria estratégica entre nossas organizações. Com nossa experiência em freight forwarding internacional e sua presença estabelecida no mercado, uma colaboração poderia gerar valor significativo para ambas as partes.",
    "Tendo revisado o escopo e a natureza de suas operações, estou confiante de que nossas capacidades logísticas podem complementar seu negócio de forma eficaz. Uma parceria poderia desbloquear eficiências, reduzir custos e melhorar os níveis de serviço em sua cadeia de suprimentos.",
    "É minha convicção que poderíamos contribuir positivamente para suas operações logísticas internacionais. A combinação de nossos serviços de carga especializados e sua experiência no mercado apresenta um caso convincente para colaboração.",
  ],
  "peer.EN": [
    "There is a compelling case for establishing a cooperative relationship between our organizations. Our model — providing competitive freight capacity to fellow forwarders without competing for end clients — is designed to strengthen your service offering while preserving your client relationships.",
    "I believe we can serve as a valuable resource for your team. By providing competitive buy rates and reliable capacity on key corridors, we enable our partners to quote more aggressively and serve their clients more flexibly — without any conflict of interest.",
    "A partnership between our firms could create a win-win dynamic: you gain access to competitive freight solutions that enhance your market position, while we contribute the operational backbone. Your clients remain yours — we simply provide the shipping muscle.",
  ],
  "peer.ES": [
    "Existe un caso convincente para establecer una relación de cooperación entre nuestras organizaciones. Nuestro modelo — proveer capacidad de carga competitiva a otros forwarders sin competir por los clientes finales — está diseñado para fortalecer su oferta de servicios preservando sus relaciones con clientes.",
    "Creo que podemos servir como un recurso valioso para su equipo. Al proveer tarifas competitivas y capacidad confiable en corredores clave, permitimos a nuestros socios cotizar de manera más agresiva y servir a sus clientes con mayor flexibilidad — sin conflicto de intereses.",
    "Una alianza entre nuestras firmas podría crear una dinámica ganar-ganar: usted obtiene acceso a soluciones de carga competitivas que mejoran su posición en el mercado, mientras nosotros contribuimos con la capacidad operativa. Sus clientes siguen siendo suyos.",
  ],
  "peer.PT": [
    "Existe um caso convincente para estabelecer uma relação de cooperação entre nossas organizações. Nosso modelo — fornecer capacidade de carga competitiva a outros forwarders sem competir pelos clientes finais — é projetado para fortalecer sua oferta de serviços preservando seus relacionamentos com clientes.",
    "Acredito que podemos servir como um recurso valioso para sua equipe. Ao fornecer tarifas competitivas e capacidade confiável em corredores-chave, permitimos que nossos parceiros cotem de forma mais agressiva e sirvam seus clientes com mais flexibilidade — sem conflito de interesses.",
    "Uma parceria entre nossas empresas poderia criar uma dinâmica ganha-ganha: você obtém acesso a soluções de carga competitivas que melhoram sua posição no mercado, enquanto contribuímos com a capacidade operacional. Seus clientes permanecem seus.",
  ],
  "general.EN": [
    "I believe there is potential for a meaningful collaboration between our organizations. Whether your international shipping needs are current or future, having a reliable logistics partner can make a significant difference in operational efficiency and cost management.",
    "Our capabilities may align well with your organization's potential logistics requirements. I would welcome the opportunity to explore whether a partnership could create value for your operations.",
  ],
  "general.ES": [
    "Creo que existe potencial para una colaboración significativa entre nuestras organizaciones. Ya sea que sus necesidades de envío internacional sean actuales o futuras, contar con un socio logístico confiable puede marcar una diferencia significativa en eficiencia operativa y gestión de costos.",
    "Nuestras capacidades pueden alinearse bien con los posibles requisitos logísticos de su organización. Agradecería la oportunidad de explorar si una colaboración podría crear valor para sus operaciones.",
  ],
  "general.PT": [
    "Acredito que existe potencial para uma colaboração significativa entre nossas organizações. Sejam suas necessidades de envio internacional atuais ou futuras, contar com um parceiro logístico confiável pode fazer uma diferença significativa na eficiência operacional e na gestão de custos.",
    "Nossas capacidades podem se alinhar bem aos possíveis requisitos logísticos de sua organização. Eu gostaria de ter a oportunidade de explorar se uma parceria poderia criar valor para suas operações.",
  ],
};

// ══════════════════════════════════════════════════════════════
// 6. services — 服务要点（bullet list，6-8 条）
// ══════════════════════════════════════════════════════════════
const services: Pool = {
  "direct.EN": [
    "As your logistics partner, we can provide comprehensive support for operations originating from key international ports, including:\n\n• Ocean freight — FCL and LCL services with competitive transit times\n• Air freight — international air cargo solutions for time-sensitive shipments\n• Supplier coordination — managing communication and logistics with suppliers at origin\n• Documentation handling — complete operational and documentary follow-through from origin to loading\n• Local support — dedicated point of contact with responsive communication\n• Customs coordination — ensuring smooth clearance and compliance processes\n• Cargo tracking — real-time visibility from departure to final destination\n• Tailored solutions — logistics plans adapted to your specific supply chain requirements",
    "We offer a full suite of international freight services designed to support your operations end to end:\n\n• Ocean freight (FCL and LCL) with regular, reliable departures\n• Air freight for urgent or high-value cargo\n• End-to-end supplier management and coordination at origin\n• Documentary and operational support from booking through delivery\n• Dedicated customer service with fast, clear communication\n• Customs brokerage coordination and compliance assistance\n• Continuous shipment tracking and status updates\n• Flexible logistics solutions tailored to your specific trade requirements",
    "Our core service capabilities include:\n\n• International ocean freight — FCL, LCL, and special equipment\n• Air freight — express and consolidated options\n• Supplier liaison — coordination, quality checks, and loading supervision at origin\n• Documentation — full set of shipping documents prepared and verified\n• Operational tracking — milestone updates from departure to arrival\n• Customs support — coordination with brokers for efficient clearance\n• Dedicated account management — one consistent point of contact\n• Consultative approach — proactive recommendations to optimize your logistics",
  ],
  "direct.ES": [
    "Como su socio logístico, podemos proporcionar soporte integral para operaciones originadas en puertos internacionales clave, incluyendo:\n\n• Carga marítima — servicios FCL y LCL con tiempos de tránsito competitivos\n• Carga aérea — soluciones de carga aérea internacional para envíos urgentes\n• Coordinación con proveedores — gestión de comunicación y logística con proveedores en origen\n• Gestión documental — seguimiento operativo y documental completo desde origen hasta el embarque\n• Soporte local — punto de contacto dedicado con comunicación ágil\n• Coordinación aduanera — asegurando procesos de despacho eficientes y cumplimiento normativo\n• Rastreo de carga — visibilidad en tiempo real desde la salida hasta el destino final\n• Soluciones personalizadas — planes logísticos adaptados a los requisitos específicos de su cadena de suministro",
    "Ofrecemos un conjunto completo de servicios de carga internacional diseñados para respaldar sus operaciones de extremo a extremo:\n\n• Carga marítima (FCL y LCL) con salidas regulares y confiables\n• Carga aérea para envíos urgentes o de alto valor\n• Gestión integral de proveedores y coordinación en origen\n• Soporte documental y operativo desde la reserva hasta la entrega\n• Servicio al cliente dedicado con comunicación rápida y clara\n• Coordinación de despacho aduanero y asistencia en cumplimiento\n• Seguimiento continuo de embarques y actualizaciones de estado\n• Soluciones logísticas flexibles adaptadas a sus necesidades comerciales",
  ],
  "direct.PT": [
    "Como seu parceiro logístico, podemos fornecer suporte abrangente para operações originadas em portos internacionais importantes, incluindo:\n\n• Frete marítimo — serviços FCL e LCL com tempos de trânsito competitivos\n• Frete aéreo — soluções de carga aérea internacional para remessas urgentes\n• Coordenação com fornecedores — gestão de comunicação e logística com fornecedores na origem\n• Gestão documental — acompanhamento operacional e documental completo desde a origem até o embarque\n• Suporte local — ponto de contato dedicado com comunicação ágil\n• Coordenação aduaneira — assegurando processos de desembaraço eficientes e conformidade\n• Rastreamento de carga — visibilidade em tempo real desde a partida até o destino final\n• Soluções personalizadas — planos logísticos adaptados aos requisitos específicos de sua cadeia de suprimentos",
    "Oferecemos um conjunto completo de serviços de carga internacional projetados para apoiar suas operações de ponta a ponta:\n\n• Frete marítimo (FCL e LCL) com partidas regulares e confiáveis\n• Frete aéreo para remessas urgentes ou de alto valor\n• Gestão completa de fornecedores e coordenação na origem\n• Suporte documental e operacional desde a reserva até a entrega\n• Atendimento ao cliente dedicado com comunicação rápida e clara\n• Coordenação de despacho aduaneiro e assistência em conformidade\n• Acompanhamento contínuo de remessas e atualizações de status\n• Soluções logísticas flexíveis adaptadas às suas necessidades comerciais",
  ],
  "peer.EN": [
    "We offer competitive freight solutions designed specifically for forwarding partners:\n\n• Ocean FCL and LCL at buy rates designed to give you a pricing edge\n• Air freight options for time-sensitive client requirements\n• Reliable slot allocation and space protection on key corridors\n• Flexible capacity coverage when your regular options are constrained\n• Transparent communication and proactive status updates\n• A strict non-compete approach — your clients remain yours, always\n• No minimum volume requirements and no exclusivity obligations",
    "Our partner-focused service includes:\n\n• Competitive ocean freight (FCL/LCL) buy rates\n• Air freight solutions at advantageous pricing\n• Priority booking access during peak seasons\n• Flexible capacity to cover your overflow or urgent needs\n• Clear, timely communication on every shipment\n• Full documentary and operational support\n• Zero client contact — we work exclusively through you",
  ],
  "peer.ES": [
    "Ofrecemos soluciones de carga competitivas diseñadas específicamente para socios forwarders:\n\n• Carga marítima FCL y LCL a tarifas diseñadas para darle ventaja en precios\n• Opciones de carga aérea para requisitos urgentes de sus clientes\n• Asignación confiable de espacio y protección de cupos en corredores clave\n• Cobertura flexible de capacidad cuando sus opciones habituales están limitadas\n• Comunicación transparente y actualizaciones proactivas de estado\n• Un enfoque estricto de no competencia — sus clientes siguen siendo suyos, siempre\n• Sin requisitos de volumen mínimo y sin obligaciones de exclusividad",
  ],
  "peer.PT": [
    "Oferecemos soluções de carga competitivas projetadas especificamente para parceiros forwarders:\n\n• Frete marítimo FCL e LCL com tarifas projetadas para lhe dar vantagem competitiva\n• Opções de frete aéreo para necessidades urgentes de seus clientes\n• Alocação confiável de espaço e proteção de cotas em corredores-chave\n• Cobertura flexível de capacidade quando suas opções habituais estão limitadas\n• Comunicação transparente e atualizações proativas de status\n• Abordagem rigorosa de não concorrência — seus clientes permanecem seus, sempre\n• Sem requisitos de volume mínimo e sem obrigações de exclusividade",
  ],
  "general.EN": [
    "We provide comprehensive international freight services that can support a wide range of shipping requirements:\n\n• Ocean freight — FCL and LCL with competitive transit times\n• Air freight — international air cargo solutions\n• Supplier coordination and management at origin\n• Complete documentation and operational support\n• Dedicated customer service with responsive communication\n• Shipment tracking and regular status updates\n• Flexible logistics solutions adapted to your specific needs",
  ],
  "general.ES": [
    "Proveemos servicios integrales de carga internacional que pueden respaldar una amplia gama de requisitos de envío:\n\n• Carga marítima — FCL y LCL con tiempos de tránsito competitivos\n• Carga aérea — soluciones internacionales de carga aérea\n• Coordinación y gestión de proveedores en origen\n• Documentación completa y soporte operativo\n• Servicio al cliente dedicado con comunicación ágil\n• Seguimiento de embarques y actualizaciones regulares de estado\n• Soluciones logísticas flexibles adaptadas a sus necesidades específicas",
  ],
  "general.PT": [
    "Fornecemos serviços abrangentes de carga internacional que podem apoiar uma ampla gama de necessidades de envio:\n\n• Frete marítimo — FCL e LCL com tempos de trânsito competitivos\n• Frete aéreo — soluções internacionais de carga aérea\n• Coordenação e gestão de fornecedores na origem\n• Documentação completa e suporte operacional\n• Atendimento ao cliente dedicado com comunicação ágil\n• Rastreamento de remessas e atualizações regulares de status\n• Soluções logísticas flexíveis adaptadas às suas necessidades específicas",
  ],
};

// ══════════════════════════════════════════════════════════════
// 7. alignment — 品质对齐
// ══════════════════════════════════════════════════════════════
const alignment: Pool = {
  "EN": [
    "We understand that your organization values service quality, responsiveness, and continuous operational follow-through. These principles are deeply embedded in our own approach to logistics management. We believe that a partnership built on shared values — reliability, transparency, and a genuine commitment to excellence — can generate lasting benefits for both organizations and the clients we serve.",
    "Quality of service, attention to detail, and proactive communication are values we hold in the highest regard — and from what I have observed, your organization shares this perspective. When two companies operate with aligned principles, the foundation for a strong and productive partnership is already in place.",
    "In international logistics, success depends on trust, consistency, and the ability to respond effectively to changing circumstances. These are the standards we hold ourselves to, and they align closely with the reputation your organization has built in the market.",
  ],
  "ES": [
    "Entendemos que su organización valora la calidad del servicio, la capacidad de respuesta y el seguimiento operativo continuo. Estos principios están profundamente arraigados en nuestro propio enfoque de gestión logística. Creemos que una alianza construida sobre valores compartidos — confiabilidad, transparencia y un genuino compromiso con la excelencia — puede generar beneficios duraderos para ambas organizaciones.",
    "La calidad del servicio, la atención al detalle y la comunicación proactiva son valores que tenemos en la más alta estima — y por lo que he observado, su organización comparte esta perspectiva. Cuando dos empresas operan con principios alineados, la base para una alianza sólida y productiva ya está establecida.",
    "En la logística internacional, el éxito depende de la confianza, la consistencia y la capacidad de responder eficazmente a circunstancias cambiantes. Estos son los estándares que nos exigimos, y se alinean estrechamente con la reputación que su organización ha construido en el mercado.",
  ],
  "PT": [
    "Entendemos que sua organização valoriza a qualidade do serviço, a capacidade de resposta e o acompanhamento operacional contínuo. Esses princípios estão profundamente enraizados em nossa própria abordagem de gestão logística. Acreditamos que uma parceria construída sobre valores compartilhados — confiabilidade, transparência e um compromisso genuíno com a excelência — pode gerar benefícios duradouros para ambas as organizações.",
    "Qualidade de serviço, atenção aos detalhes e comunicação proativa são valores que temos na mais alta consideração — e, pelo que observei, sua organização compartilha dessa perspectiva. Quando duas empresas operam com princípios alinhados, a base para uma parceria sólida e produtiva já está estabelecida.",
    "Na logística internacional, o sucesso depende de confiança, consistência e capacidade de responder efetivamente a circunstâncias em mudança. Esses são os padrões que nos exigimos, e eles se alinham estreitamente com a reputação que sua organização construiu no mercado.",
  ],
};

// ══════════════════════════════════════════════════════════════
// 8. cta — 行动号召（按阶段分）
// ══════════════════════════════════════════════════════════════
const cta: Pool = {
  "initial.direct.EN": [
    "I would welcome the opportunity to present YQN Logistics in greater detail and to better understand how we might support your organization in future operations. If there is interest, I would be happy to schedule a brief introductory call at your convenience.",
    "Should this be of interest, I would be pleased to provide additional information about our services and to discuss how we could contribute to your logistics operations. Please do not hesitate to reach out at a time that suits you.",
    "I would be glad to arrange a preliminary discussion to explore potential areas of collaboration. If the timing is right, please let me know and I will make myself available at your earliest convenience.",
  ],
  "initial.direct.ES": [
    "Agradecería la oportunidad de presentar YQN Logistics con mayor detalle y comprender mejor cómo podríamos apoyar a su organización en futuras operaciones. Si existe interés, estaré encantado de programar una breve llamada introductoria cuando le sea conveniente.",
    "Si esto fuera de su interés, tendré el gusto de proporcionar información adicional sobre nuestros servicios y discutir cómo podríamos contribuir a sus operaciones logísticas. No dude en contactarme en el momento que mejor le convenga.",
    "Con gusto organizaría una conversación preliminar para explorar posibles áreas de colaboración. Si el momento es oportuno, por favor hágamelo saber y me pondré a su disposición.",
  ],
  "initial.direct.PT": [
    "Eu gostaria de ter a oportunidade de apresentar a YQN Logistics com mais detalhes e entender melhor como poderíamos apoiar sua organização em futuras operações. Se houver interesse, terei prazer em agendar uma breve chamada introdutória conforme sua conveniência.",
    "Se isso for de seu interesse, terei o prazer de fornecer informações adicionais sobre nossos serviços e discutir como poderíamos contribuir para suas operações logísticas. Não hesite em entrar em contato no momento que lhe for mais conveniente.",
    "Com prazer organizaria uma conversa preliminar para explorar possíveis áreas de colaboração. Se for o momento adequado, por favor me avise e estarei à sua disposição.",
  ],
  "followup1.direct.EN": [
    "I wanted to follow up on my previous message and ensure it reached you. I remain genuinely interested in exploring how we might support your operations, and I would welcome the opportunity to discuss this further at a time that works for you.",
    "Following up briefly on my earlier communication — I understand that these matters require consideration, and I did not want my previous message to go unnoticed. I remain at your disposal should you wish to discuss further.",
    "I am writing to follow up on my initial outreach. Please know that there is no urgency — I simply wanted to reaffirm my interest in establishing a dialogue and to make myself available whenever it might be convenient for you.",
  ],
  "followup1.direct.ES": [
    "Quería dar seguimiento a mi mensaje anterior y asegurarme de que le haya llegado. Sigo genuinamente interesado en explorar cómo podríamos apoyar sus operaciones, y agradecería la oportunidad de discutirlo cuando le sea conveniente.",
    "Un breve seguimiento a mi comunicación anterior — entiendo que estos temas requieren consideración, y no quería que mi mensaje previo pasara desapercibido. Quedo a su disposición si desea conversar más al respecto.",
    "Escribo para dar seguimiento a mi contacto inicial. Por favor, sepa que no hay urgencia — simplemente quería reafirmar mi interés en establecer un diálogo y ponerme a su disposición para cuando sea conveniente.",
  ],
  "followup1.direct.PT": [
    "Gostaria de acompanhar minha mensagem anterior e garantir que ela chegou até você. Continuo genuinamente interessado em explorar como poderíamos apoiar suas operações, e gostaria de ter a oportunidade de discutir isso quando for conveniente.",
    "Um breve acompanhamento da minha comunicação anterior — entendo que esses assuntos exigem consideração, e não queria que minha mensagem anterior passasse despercebida. Estou à sua disposição caso deseje conversar mais.",
    "Escrevo para acompanhar meu contato inicial. Por favor, saiba que não há urgência — apenas queria reafirmar meu interesse em estabelecer um diálogo e me colocar à disposição para quando for conveniente.",
  ],
  "followup2.direct.EN": [
    "I will keep this brief as I respect your time and the demands of your schedule. Should the prospect of exploring a logistics partnership become relevant at a later stage, please do not hesitate to reach out. The door remains open.",
    "I understand that timing may not be right at this moment, and I fully respect that. If your circumstances or requirements evolve in the future, I would be glad to reconnect and explore how we might be of service.",
    "This will be my final follow-up — I do not wish to impose on your time. If and when international logistics support becomes a priority for your organization, you are most welcome to contact me. I wish you continued success.",
  ],
  "followup2.direct.ES": [
    "Seré breve, ya que respeto su tiempo y las exigencias de su agenda. Si la perspectiva de explorar una alianza logística se vuelve relevante en una etapa posterior, no dude en contactarme. La puerta permanece abierta.",
    "Entiendo que el momento puede no ser el adecuado en esta ocasión, y lo respeto plenamente. Si sus circunstancias o requisitos evolucionan en el futuro, tendré mucho gusto en reconectar y explorar cómo podríamos ser de servicio.",
    "Este será mi último seguimiento — no deseo imponerle mi tiempo. Si y cuando el soporte logístico internacional se convierta en una prioridad para su organización, estará más que bienvenido a contactarme. Le deseo éxito continuo.",
  ],
  "followup2.direct.PT": [
    "Serei breve, pois respeito seu tempo e as demandas de sua agenda. Se a perspectiva de explorar uma parceria logística se tornar relevante em um momento posterior, não hesite em entrar em contato. A porta permanece aberta.",
    "Entendo que o momento pode não ser o adequado nesta ocasião, e respeito plenamente isso. Se suas circunstâncias ou necessidades evoluírem no futuro, terei muito prazer em reconectar e explorar como poderíamos ser úteis.",
    "Este será meu último acompanhamento — não desejo impor meu tempo. Se e quando o suporte logístico internacional se tornar uma prioridade para sua organização, você será mais que bem-vindo a me contatar. Desejo-lhe sucesso contínuo.",
  ],
  "closing.direct.EN": [
    "To make the next step as straightforward as possible, I would be pleased to prepare a preliminary quotation based on your specific requirements. Simply share the details of one shipment — origin, destination, and cargo type — and I will provide a concrete proposal within 24 hours, without any obligation on your part.",
    "I would like to propose a practical next step: share with me the specifications of one of your regular shipments, and allow me to present a competitive quotation. If the numbers make sense, we can explore further. If not, there is no obligation whatsoever.",
    "If you are open to evaluating our capabilities, I suggest we start with a single trial shipment. This would allow you to assess our service quality, communication, and reliability firsthand — with no commitment beyond that initial booking.",
  ],
  "closing.direct.ES": [
    "Para hacer el siguiente paso lo más sencillo posible, tendré el gusto de preparar una cotización preliminar basada en sus requisitos específicos. Simplemente comparta los detalles de un embarque — origen, destino y tipo de carga — y le proporcionaré una propuesta concreta en 24 horas, sin ninguna obligación de su parte.",
    "Me gustaría proponer un siguiente paso práctico: compártame las especificaciones de uno de sus embarques habituales y permítame presentar una cotización competitiva. Si los números tienen sentido, podemos explorar más. Si no, no hay ninguna obligación.",
    "Si está abierto a evaluar nuestras capacidades, sugiero comenzar con un solo embarque de prueba. Esto le permitiría evaluar nuestra calidad de servicio, comunicación y confiabilidad de primera mano — sin compromiso más allá de esa reserva inicial.",
  ],
  "closing.direct.PT": [
    "Para tornar o próximo passo o mais simples possível, terei o prazer de preparar uma cotação preliminar com base em seus requisitos específicos. Basta compartilhar os detalhes de um embarque — origem, destino e tipo de carga — e fornecerei uma proposta concreta em 24 horas, sem qualquer obrigação de sua parte.",
    "Gostaria de propor um próximo passo prático: compartilhe comigo as especificações de um de seus embarques habituais e permita-me apresentar uma cotação competitiva. Se os números fizerem sentido, podemos explorar mais. Se não, não há obrigação alguma.",
    "Se você estiver aberto a avaliar nossas capacidades, sugiro começar com um único embarque de teste. Isso permitiria que você avaliasse nossa qualidade de serviço, comunicação e confiabilidade em primeira mão — sem compromisso além dessa reserva inicial.",
  ],
  "reactivate.direct.EN": [
    "It has been some time since we last communicated, and I hope this message finds you and your organization well. Our capabilities have continued to develop since we last spoke, and I wanted to respectfully check whether your international logistics requirements may have evolved. I remain at your disposal should there be a renewed opportunity to collaborate.",
    "I am reaching out after a period of time to see how your organization is progressing and whether any changes in your shipping needs might create an opportunity for us to reconnect. Our team and service capabilities have grown, and we would be glad to re-engage if and when the timing is right.",
    "I wanted to touch base after some time and extend my continued availability. If your logistics landscape has shifted — new trade volumes, new requirements, or simply a desire to benchmark your current arrangements — I would be pleased to provide an updated perspective.",
  ],
  "reactivate.direct.ES": [
    "Ha pasado algún tiempo desde nuestra última comunicación, y espero que este mensaje les encuentre bien a usted y a su organización. Nuestras capacidades han seguido desarrollándose desde la última vez que hablamos, y quería respetuosamente verificar si sus requisitos logísticos internacionales pueden haber evolucionado. Sigo a su disposición.",
    "Me pongo en contacto después de un tiempo para ver cómo está progresando su organización y si algún cambio en sus necesidades de envío podría crear una oportunidad para reconectar. Nuestro equipo y capacidades han crecido, y nos encantaría volver a conversar si el momento es adecuado.",
    "Quería saludar después de un tiempo y extender mi continua disponibilidad. Si su panorama logístico ha cambiado — nuevos volúmenes, nuevos requisitos o simplemente el deseo de comparar sus arreglos actuales — tendré mucho gusto en proporcionar una perspectiva actualizada.",
  ],
  "reactivate.direct.PT": [
    "Já faz algum tempo desde nossa última comunicação, e espero que esta mensagem encontre você e sua organização bem. Nossas capacidades continuaram a se desenvolver desde a última vez que conversamos, e queria respeitosamente verificar se seus requisitos logísticos internacionais podem ter evoluído. Permaneço à sua disposição.",
    "Estou entrando em contato depois de um período para ver como sua organização está progredindo e se alguma mudança em suas necessidades de envio poderia criar uma oportunidade para reconectarmos. Nossa equipe e capacidades de serviço cresceram, e teríamos prazer em reengajar se e quando for o momento certo.",
    "Queria cumprimentar depois de algum tempo e estender minha contínua disponibilidade. Se seu cenário logístico mudou — novos volumes, novos requisitos ou simplesmente o desejo de comparar seus arranjos atuais — terei prazer em fornecer uma perspectiva atualizada.",
  ],
};

// peer CTA — 复用 direct 变体 + 回退机制
// (通过 getVariants fallback → direct 池)

// ══════════════════════════════════════════════════════════════
// 9. redirect — 转发请求
// ══════════════════════════════════════════════════════════════
const redirect: Pool = {
  "EN": [
    "Should this area fall under the responsibility of another department or individual within your organization, I would be grateful if you could forward this message to the appropriate contact. Thank you in advance for your assistance.",
    "If your organization handles international partnerships through a different department, I would sincerely appreciate it if you could direct this message to the relevant team. I thank you for your guidance.",
    "In the event that this correspondence should be directed elsewhere within your organization, I would be most grateful for your help in forwarding it to the appropriate person or department.",
  ],
  "ES": [
    "En caso de que esta área sea conducida por otro departamento o persona dentro de su organización, agradecería enormemente que pudiera reenviar este mensaje al contacto apropiado. Muchas gracias por su ayuda.",
    "Si su organización gestiona las alianzas internacionales a través de un departamento diferente, apreciaría sinceramente que pudiera dirigir este mensaje al equipo correspondiente. Le agradezco su orientación.",
    "Si esta correspondencia debe ser dirigida a otra área dentro de su organización, estaré muy agradecido por su ayuda para reenviarla a la persona o departamento apropiado.",
  ],
  "PT": [
    "Caso esta área seja conduzida por outro departamento ou pessoa dentro de sua organização, eu agradeceria muito se pudesse encaminhar esta mensagem ao contato apropriado. Muito obrigado pela sua ajuda.",
    "Se sua organização gerencia parcerias internacionais através de um departamento diferente, eu apreciaria sinceramente se pudesse direcionar esta mensagem à equipe relevante. Agradeço sua orientação.",
    "Caso esta correspondência deva ser direcionada a outra área dentro de sua organização, ficarei muito grato por sua ajuda em encaminhá-la à pessoa ou departamento apropriado.",
  ],
};

// ══════════════════════════════════════════════════════════════
// 10. thanks — 感谢与期望
// ══════════════════════════════════════════════════════════════
const thanks: Pool = {
  "EN": [
    "Thank you very much for your time and attention. I sincerely hope that we may have the opportunity to build a solid and lasting partnership in the near future.",
    "I appreciate the time you have taken to read this message. It is my hope that our paths may cross in a way that brings value to both of our organizations.",
    "Thank you for considering this introduction. I look forward to the possibility of working together and contributing to our mutual success.",
  ],
  "ES": [
    "Muchas gracias por su tiempo y atención. Espero sinceramente que podamos tener la oportunidad de construir una alianza sólida y duradera en un futuro cercano.",
    "Agradezco el tiempo que ha dedicado a leer este mensaje. Espero que nuestros caminos puedan cruzarse de una manera que aporte valor a ambas organizaciones.",
    "Gracias por considerar esta presentación. Espero con interés la posibilidad de trabajar juntos y contribuir a nuestro éxito mutuo.",
  ],
  "PT": [
    "Muito obrigado pelo seu tempo e atenção. Espero sinceramente que possamos ter a oportunidade de construir uma parceria sólida e duradoura em um futuro próximo.",
    "Agradeço o tempo que dedicou a ler esta mensagem. É minha esperança que nossos caminhos possam se cruzar de uma forma que traga valor a ambas as organizações.",
    "Obrigado por considerar esta apresentação. Aguardo com expectativa a possibilidade de trabalharmos juntos e contribuirmos para nosso sucesso mútuo.",
  ],
};

// ══════════════════════════════════════════════════════════════
// 11. closing — 正式收尾（不含署名）
// ══════════════════════════════════════════════════════════════
const closing: Pool = {
  "EN": [
    "{Sincerely|Yours faithfully|Respectfully},",
    "{Kind regards|Best regards|With appreciation},",
    "{Yours sincerely|Cordially|With kind regards},",
  ],
  "ES": [
    "{Atentamente|Cordialmente|Respetuosamente},",
    "{Saludos cordiales|Un cordial saludo|Atentos saludos},",
    "{Quedo a su disposición|A la espera de su grata respuesta|Con consideración},",
  ],
  "PT": [
    "{Atenciosamente|Cordialmente|Respeitosamente},",
    "{Saudações cordiais|Com os melhores cumprimentos|Atentamente},",
    "{À sua disposição|Agradecido pela atenção|Com consideração},",
  ],
};

// ══════════════════════════════════════════════════════════════
// 池访问
// ══════════════════════════════════════════════════════════════

function pickOne(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function getVariants(p: Pool, key: string): string[] {
  return p[key] || p[key.replace(/\.[^.]+$/, ".general")] || p[key.replace(/^[^.]+\./, "direct.")] || [];
}

function getPool(component: string): Pool {
  switch (component) {
    case "salutation": return salutation;
    case "pleasantry": return pleasantry;
    case "intro": return intro;
    case "discovery": return discovery;
    case "bridge": return bridge;
    case "services": return services;
    case "alignment": return alignment;
    case "redirect": return redirect;
    case "thanks": return thanks;
    case "closing": return closing;
    default: return {};
  }
}

function pickComponent(component: string, lang: Lang, clientType: ClientType, stage?: Stage): string | null {
  let key: string;
  switch (component) {
    case "salutation": case "pleasantry": case "alignment": case "redirect": case "thanks": case "closing":
      key = lang; break;
    case "intro": case "discovery": case "bridge": case "services":
      key = `${clientType}.${lang}`; break;
    case "cta": {
      if (!stage) return null;
      key = `${stage}.direct.${lang}`;
      let vars = getVariants(cta, key);
      if (vars.length === 0) vars = getVariants(cta, `${stage}.general.${lang}`);
      if (vars.length === 0) vars = getVariants(cta, `initial.direct.${lang}`);
      return vars.length > 0 ? pickOne(vars) : null;
    }
    default: return null;
  }
  const pool = getPool(component);
  const vars = getVariants(pool, key);
  return vars.length > 0 ? pickOne(vars) : null;
}

// ══════════════════════════════════════════════════════════════
// 组装引擎
// ══════════════════════════════════════════════════════════════

export interface AssembleInput {
  lang: Lang;
  clientType: ClientType;
  stage: Stage;
  includeCompany?: boolean;
}

export function assembleEmail(input: AssembleInput): { subject: string; body: string } {
  const { lang, clientType, stage, includeCompany } = input;
  const parts: string[] = [];

  // 1. 称呼
  const sal = pickComponent("salutation", lang, clientType);
  if (sal) parts.push(sal, "");

  // 2. 问候
  const ple = pickComponent("pleasantry", lang, clientType);
  if (ple) parts.push(ple, "");

  // 3. 自我介绍
  const itr = pickComponent("intro", lang, clientType);
  if (itr) parts.push(itr, "");

  // 4. 认知来源（可控）
  const disc = pickComponent("discovery", lang, clientType);
  if (disc && includeCompany) parts.push(disc, "");

  // 5. 价值连接
  const brg = pickComponent("bridge", lang, clientType);
  if (brg) parts.push(brg, "");

  // 6. 服务要点
  const svc = pickComponent("services", lang, clientType);
  if (svc) parts.push(svc, "");

  // 7. 品质对齐
  const aln = pickComponent("alignment", lang, clientType);
  if (aln && stage !== "reactivate") parts.push(aln, "");

  // 8. CTA
  const ct = pickComponent("cta", lang, clientType, stage);
  if (ct) parts.push(ct, "");

  // 9. 转发请求
  const redir = pickComponent("redirect", lang, clientType);
  if (redir) parts.push(redir, "");

  // 10. 感谢
  const thx = pickComponent("thanks", lang, clientType);
  if (thx) parts.push(thx, "");

  // 11. 收尾（不含署名，签名由系统自动追加）
  const cls = pickComponent("closing", lang, clientType);
  if (cls) parts.push(cls);

  let body = parts.join("\n");

  // 处理 {a|b|c} 随机词 — 让预览直接展示最终效果
  body = body.replace(/\{([^{}|]+\|[^{}]+)\}/g, (_m, choices: string) => {
    const opts = choices.split("|");
    return opts[Math.floor(Math.random() * opts.length)]!;
  });

  // 主题
  const subjects: Record<string, string[]> = {
    EN: [
      "Introduction — international logistics support",
      "Exploring a potential logistics partnership",
      "Regarding international freight cooperation",
      "Introduction and logistics partnership inquiry",
    ],
    ES: [
      "Presentación — soporte logístico internacional",
      "Explorando una posible alianza logística",
      "Cooperación en carga internacional",
      "Presentación y propuesta de colaboración logística",
    ],
    PT: [
      "Apresentação — suporte logístico internacional",
      "Explorando uma possível parceria logística",
      "Cooperação em carga internacional",
      "Apresentação e proposta de parceria logística",
    ],
  };
  let subject = pickOne(subjects[lang] || subjects["EN"]!);
  subject = subject.replace(/\{([^{}|]+\|[^{}]+)\}/g, (_m, choices: string) => {
    const opts = choices.split("|");
    return opts[Math.floor(Math.random() * opts.length)]!;
  });

  return { subject, body };
}
