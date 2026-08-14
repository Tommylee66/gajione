# GajiOne

인도네시아向け 급여(Payroll) SaaS "GajiOne" 기획 프로토타입 모음입니다. 모든 화면은 외부 의존성 없이 동작하는 단일 HTML 파일이며, 실제 서비스 백엔드는 연결되어 있지 않은 목업(mockup)입니다.

## 화면 목록

| 파일 | 설명 |
| --- | --- |
| [index.html](index.html) | 서비스 기획 리뷰 문서 (개요, IA, 4-Gate 파이프라인, 화면별 설명, 규칙, 참고자료) |
| [app.html](app.html) | 페이롤 관리자(고객사) 화면 — G1~G4 품질게이트, 원천데이터 업로드, 대출, 직원 앱 미리보기, 관리(직원 마스터/정책·요율), 지문인식기 연동 |
| [lender-portal.html](lender-portal.html) | 제3자 금융기관용 대출 실행 관리 화면 |
| [admin-console.html](admin-console.html) | GajiOne 운영사(마스터) 관리자 화면 — 고객사 관리, 요금제·빌링, 대시보드 |
| [auth.html](auth.html) | 서비스 가입 플로우 — 로그인, 회원가입, 비밀번호 찾기, 약관 동의 |
| [employee-app-mobile.html](employee-app-mobile.html) | 직원용 모바일 앱(iOS / Android 스타일) 목업 |

## 참고

- 모든 화면은 한국어/영어/인도네시아어/중국어/일본어 5개 언어와 라이트/다크 테마를 지원합니다.
- 업로드 화면은 실제 `AI_Payroll_PPh21_Upload_Template.xlsx` 형식을 기준으로 만든 브라우저 내장 XLSX/CSV 파서로 동작합니다.
- 프로토타입이며 실제 결제·인증·데이터 저장 기능은 없습니다.
